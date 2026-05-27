// supabase/functions/scoper/plan.ts
// AGT.1.2 — Scoper v3 plan mode (6-step playbook).
//
// Step 1: lock mode, verify input, loop guards (dedup 30s, hourly cap 5)
// Step 2: Working Backwards decomposition (decomposition.ts)
//          - Generate mode: LLM creates clauses from grill + architecture
//          - Enrich mode: reads existing clauses, enriches ACs
// Step 3: AC derivation (folded into decomposition output)
// Step 4: 7-point prerequisite check (prerequisites.ts)
//          - #5 ARCHITECTURE + #6 GRILL: MANDATORY GATES, no inline fix
// Step 5: wave organization (waves.ts)
// Step 6: emit
//          - Mode A: dispatch_tree row + PROMOTE clauses + call /dispatch/tree
//                    + clear scoper_findings + signal
//          - Mode B: features.scoper_findings jsonb + signal scoper_held
//          - Mode C: decision_queue row + signal scoper_escalate
//
// GAP 2 fix (2026-05-26): Step 6 Mode A now atomically:
//   1. Writes ACs back to bible_clauses
//   2. Promotes clauses: status='active', approved_for_dispatch=true, maturity_stage='SCAFFOLD'
//   3. Calls POST /dispatch/tree to trigger workers
//   Per grill decision 63b43107 (supersedes f11b5d02): Scoper flips both gates.

import { resolveAuditTrail } from "../common/audit_trail.ts";
import { hashInput, checkDedup, checkHourlyCap } from "../common/loop_guard.ts";
import { finalizeStep, writeScoperStep } from "../common/logging.ts";
import { getSupabaseClient } from "../common/db.ts";
import { runPrerequisiteChecks } from "./prerequisites.ts";
import type { FeatureRow, ProjectRow } from "./prerequisites.ts";
import { decomposeFeature } from "./decomposition.ts";
import { organizeWaves } from "./waves.ts";
import {
  DEDUP_WINDOW_SECONDS,
  HOURLY_PLAN_CAP,
  insertDispatchTree,
  emitScoperSignal,
  writeScoperFindings,
  insertDecisionQueue,
  jsonResponse,
} from "./_shared.ts";
import type { AuditTrail } from "../common/types.ts";

export interface PlanRequest {
  mode: "plan";
  feature_id: string;
  grill_resolution_id?: string;
  triggered_by_agent_id?: string;
  agent_id?: string;
  session_id?: string;
  sid?: string;
  org_id?: string | null;
  parent_run_id?: string | null;
}

interface PlanResponse {
  outcome_mode: "A" | "B" | "C";
  feature_id: string;
  scoper_run_id: string;
  dispatch_tree_id: string | null;
  dispatch_tree?: Record<string, unknown>;
  scoper_findings?: Record<string, unknown> | null;
  decision_queue_id?: string | null;
  signal: string;
  dedup_skip?: boolean;
  loop_halt?: boolean;
  prior_run_id?: string;
  generated?: boolean;
  clauses_promoted?: number;
  dispatch_triggered?: boolean;
}

function parsePlanBody(body: unknown): PlanRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be JSON object" };
  const b = body as Record<string, unknown>;
  if (b.mode !== "plan") return { error: "mode must be 'plan'" };
  if (typeof b.feature_id !== "string" || b.feature_id.length === 0) {
    return { error: "feature_id required" };
  }
  return {
    mode: "plan",
    feature_id: b.feature_id,
    grill_resolution_id: typeof b.grill_resolution_id === "string" ? b.grill_resolution_id : undefined,
    triggered_by_agent_id: typeof b.triggered_by_agent_id === "string" ? b.triggered_by_agent_id : undefined,
    agent_id: typeof b.agent_id === "string" ? b.agent_id : undefined,
    session_id: typeof b.session_id === "string" ? b.session_id : undefined,
    sid: typeof b.sid === "string" ? b.sid : undefined,
    org_id: typeof b.org_id === "string" ? b.org_id : (b.org_id === null ? null : undefined),
    parent_run_id: typeof b.parent_run_id === "string" ? b.parent_run_id : null,
  };
}

async function loadFeature(feature_id: string): Promise<FeatureRow | null> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("features")
    .select(
      "id, project, name, description, clauses, grill_completed_at, grill_decision_count, architecture_completed_at, architecture_doc_path, architecture_doc",
    )
    .eq("id", feature_id)
    .maybeSingle();
  if (error) {
    throw new Error(`plan.loadFeature(${feature_id}): ${error.message}`);
  }
  return data ? (data as unknown as FeatureRow) : null;
}

async function loadProject(tag: string): Promise<ProjectRow | null> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("projects")
    .select("tag, canonical_repo, canonical_vercel_project, deploy_target, supabase_ref")
    .eq("tag", tag)
    .maybeSingle();
  if (error) {
    throw new Error(`plan.loadProject(${tag}): ${error.message}`);
  }
  return data ? (data as unknown as ProjectRow) : null;
}

export async function handlePlan(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const parsed = parsePlanBody(body);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);

  return await runPlan(parsed, body as Record<string, unknown>);
}

// Public so replan.ts can reuse the full playbook with extra inputs.
export async function runPlan(
  req: PlanRequest,
  rawBody: Record<string, unknown>,
  overrides: {
    prior_plan_id?: string;
    failure_context?: Record<string, unknown>;
    mode?: "plan" | "replan";
  } = {},
): Promise<Response> {
  const startTs = Date.now();
  const audit = resolveAuditTrail(rawBody);
  const mode = overrides.mode ?? "plan";

  // ─── Step 1: lock mode, verify input, loop guards ──────────────────────────

  const input_hash = await hashInput({
    mode, feature_id: req.feature_id, prior_plan_id: overrides.prior_plan_id ?? null,
  });
  const group_key = `${mode}:${req.feature_id}`;

  // dedup_skip: identical input within 30s → return cached prior run
  const prior = await checkDedup("scoper_log", input_hash, DEDUP_WINDOW_SECONDS);
  if (prior) {
    await writeScoperStep({
      feature_id: req.feature_id,
      project: "unknown",
      mode,
      step: 1,
      step_name: "loop_guard_dedup_skip",
      step_input: { input_hash, group_key, prior_run_id: prior },
      step_output: { outcome: "dedup_skip", cached_run_id: prior },
      reasoning_summary: "identical input within dedup window — returning cached run_id",
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id ?? null,
    });
    await emitScoperSignal("dedup_skip", "unknown", audit.triggered_by_agent_id, audit.session_id,
      `dedup hit on ${mode}/${req.feature_id}`, { prior_run_id: prior });
    const resp: PlanResponse = {
      outcome_mode: "B",
      feature_id: req.feature_id,
      scoper_run_id: prior,
      dispatch_tree_id: null,
      signal: "dedup_skip",
      dedup_skip: true,
      prior_run_id: prior,
    };
    return jsonResponse(resp, 200);
  }

  // hourly cap: 5th plan on same feature within 1h → refusal
  const capped = await checkHourlyCap("scoper_log", group_key, HOURLY_PLAN_CAP);
  if (capped) {
    const runId = await writeScoperStep({
      feature_id: req.feature_id,
      project: "unknown",
      mode,
      step: 1,
      step_name: "loop_guard_hourly_cap",
      step_input: { input_hash, group_key, cap: HOURLY_PLAN_CAP },
      step_output: { outcome: "loop_halt", reason: "hourly_cap_exceeded" },
      reasoning_summary: `${HOURLY_PLAN_CAP}th plan within 1h refused`,
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id ?? null,
      error: "hourly_cap_exceeded",
    });
    await emitScoperSignal("loop_halt", "unknown", audit.triggered_by_agent_id, audit.session_id,
      `hourly cap (${HOURLY_PLAN_CAP}) hit on ${mode}/${req.feature_id}`, { group_key });
    const resp: PlanResponse = {
      outcome_mode: "C",
      feature_id: req.feature_id,
      scoper_run_id: runId,
      dispatch_tree_id: null,
      signal: "loop_halt",
      loop_halt: true,
    };
    return jsonResponse(resp, 429);
  }

  // Open step-1 row (input lock). parent_run_id chains subsequent steps.
  const step1Id = await writeScoperStep({
    feature_id: req.feature_id,
    project: "unknown",
    mode,
    step: 1,
    step_name: "lock_input_verify",
    step_input: { input_hash, group_key, ...req, prior_plan_id: overrides.prior_plan_id ?? null },
    org_id: audit.org_id,
    triggered_by_agent_id: audit.triggered_by_agent_id,
    session_id: audit.session_id,
    parent_run_id: audit.parent_run_id ?? null,
  });

  // ─── Load feature + project rows (cold reads) ──────────────────────────────

  const feature = await loadFeature(req.feature_id);
  if (!feature) {
    await finalizeStep("scoper_log", step1Id, {
      step_output: { outcome: "feature_not_found" },
      error: "feature_not_found",
      duration_ms: Date.now() - startTs,
    });
    return jsonResponse({ error: "feature_not_found", feature_id: req.feature_id }, 404);
  }
  const project = await loadProject(feature.project);
  if (!project) {
    await finalizeStep("scoper_log", step1Id, {
      step_output: { outcome: "project_not_found", project: feature.project },
      error: "project_not_found",
      duration_ms: Date.now() - startTs,
    });
    return jsonResponse({ error: "project_not_found", project: feature.project }, 404);
  }
  await finalizeStep("scoper_log", step1Id, {
    step_output: { feature_loaded: feature.id, project_loaded: project.tag },
    duration_ms: Date.now() - startTs,
  });

  // ─── Step 2 + Step 3: Working Backwards decomposition + AC derivation ──────

  const step2Start = Date.now();
  const clauseIds = (feature.clauses ?? []).filter((c) => typeof c === "string");
  let decomposition: Awaited<ReturnType<typeof decomposeFeature>>;
  try {
    decomposition = await decomposeFeature(
      feature.id,
      feature.name,
      feature.description,
      clauseIds,
      {
        architectureDoc: feature.architecture_doc ?? null,
        projectTag: project.tag,
        sessionId: step1Id,
      },
    );
  } catch (decompErr) {
    // Diagnostic: log the actual error to scoper_log so we can see what killed step 2
    const errMsg = decompErr instanceof Error ? decompErr.message : String(decompErr);
    const errStack = decompErr instanceof Error ? decompErr.stack : undefined;
    console.error(`[scoper] decomposeFeature FAILED: ${errMsg}`);
    await logStep(
      feature, project.tag, mode, 2, "working_backwards_decomposition",
      { feature_id: feature.id, clause_count: clauseIds.length, error_diagnostic: true },
      { error: errMsg, stack: errStack?.slice(0, 500) },
      audit, step1Id, step2Start,
      { error: `decomposeFeature crashed: ${errMsg}` },
    );
    throw decompErr;
  }
  // Derive model_used from token counts: if LLM was called, tokens > 0
  const llmModelUsed = (decomposition.tokens_in ?? 0) > 0 ? "claude-opus-4-20250514" : undefined;

  const step2Id = await logStep(
    feature, project.tag, mode, 2, "working_backwards_decomposition",
    {
      feature_id: feature.id,
      clause_count: clauseIds.length,
      generated: decomposition.generated,
      tokens_in: decomposition.tokens_in,
      tokens_out: decomposition.tokens_out,
      cost_usd: decomposition.cost_usd,
    },
    {
      customer_experience: decomposition.customer_experience,
      precondition_count: decomposition.preconditions.length,
      clause_count: decomposition.clauses.length,
      generated: decomposition.generated,
      llm_enriched: !decomposition.generated && (decomposition.tokens_in ?? 0) > 0,
    },
    audit, step1Id, step2Start,
    // Populate top-level scoper_log columns for observability
    {
      model_used: llmModelUsed,
      tokens_in: decomposition.tokens_in,
      tokens_out: decomposition.tokens_out,
      estimated_cost_usd: decomposition.cost_usd,
    },
  );
  const _step3Id = await logStep(
    feature, project.tag, mode, 3, "ac_derivation",
    { clause_count: decomposition.clauses.length },
    {
      total_acs: decomposition.clauses.reduce((s, c) => s + c.acceptance_criteria.length, 0),
      verification_breakdown: countVerifications(decomposition.clauses),
    },
    audit, step2Id, Date.now(),
  );

  // ─── Step 4: 7-point prerequisite check ────────────────────────────────────

  const step4Start = Date.now();
  const prereq = await runPrerequisiteChecks(feature, project);
  const step4Id = await logStep(
    feature, project.tag, mode, 4, "prerequisite_check",
    { feature_id: feature.id },
    {
      all_pass: prereq.all_pass,
      mandatory_gates_pass: prereq.mandatory_gates_pass,
      blocking_failures: prereq.blocking_failures.map((b) => ({ point: b.point, name: b.name, detail: b.detail })),
      outcomes: prereq.outcomes,
    },
    audit, step2Id, step4Start,
  );

  // Hard gate: missing ARCHITECTURE.md (#5) or grill (#6) ⇒ Mode B, no exception
  if (!prereq.mandatory_gates_pass) {
    const findings = {
      mode_b_reason: "mandatory_gate_failure",
      blocked_on: prereq.outcomes.filter((o) => o.gate === "mandatory" && o.result === "fail")
        .map((o) => ({ point: o.point, name: o.name, detail: o.detail })),
      all_outcomes: prereq.outcomes,
      scoped_at: new Date().toISOString(),
      run_id: step4Id,
    };
    await writeScoperFindings(feature.id, findings, mode);
    await emitScoperSignal("scoper_held", project.tag, audit.triggered_by_agent_id, audit.session_id,
      `Mode B: ${findings.blocked_on.map((b) => b.name).join(", ")}`, { feature_id: feature.id, run_id: step4Id });
    const runId = await logStep(
      feature, project.tag, mode, 6, "emit_mode_b",
      { reason: "mandatory_gate_failure" },
      { outcome_mode: "B", findings_keys: Object.keys(findings), signal: "scoper_held" },
      audit, step4Id, Date.now(),
    );
    const resp: PlanResponse = {
      outcome_mode: "B",
      feature_id: feature.id,
      scoper_run_id: runId,
      dispatch_tree_id: null,
      scoper_findings: findings,
      signal: "scoper_held",
    };
    return jsonResponse(resp, 200);
  }

  // Soft gates: any other prerequisite failure → Mode B (held with findings) too.
  if (!prereq.all_pass) {
    const findings = {
      mode_b_reason: "soft_prerequisite_failure",
      blocked_on: prereq.blocking_failures.map((o) => ({ point: o.point, name: o.name, detail: o.detail })),
      all_outcomes: prereq.outcomes,
      scoped_at: new Date().toISOString(),
      run_id: step4Id,
    };
    await writeScoperFindings(feature.id, findings, mode);
    await emitScoperSignal("scoper_held", project.tag, audit.triggered_by_agent_id, audit.session_id,
      `Mode B: ${findings.blocked_on.length} soft prereq fail(s)`, { feature_id: feature.id, run_id: step4Id });
    const runId = await logStep(
      feature, project.tag, mode, 6, "emit_mode_b",
      { reason: "soft_prerequisite_failure" },
      { outcome_mode: "B", signal: "scoper_held" },
      audit, step4Id, Date.now(),
    );
    const resp: PlanResponse = {
      outcome_mode: "B",
      feature_id: feature.id,
      scoper_run_id: runId,
      dispatch_tree_id: null,
      scoper_findings: findings,
      signal: "scoper_held",
    };
    return jsonResponse(resp, 200);
  }

  // ─── Step 5: wave organization ─────────────────────────────────────────────

  const step5Start = Date.now();

  // Structural-block guard: if decomposition produced zero clauses but feature
  // is claiming SCAFFOLD maturity, that's a structural problem → Mode C.
  if (decomposition.clauses.length === 0) {
    const question = `Feature ${feature.id} (${feature.name ?? ""}) has no clauses to plan. Structurally cannot proceed.`;
    const decId = await insertDecisionQueue(project.tag, feature.id, question, {
      feature_id: feature.id,
      customer_experience: decomposition.customer_experience,
      scoped_at: new Date().toISOString(),
    });
    await emitScoperSignal("scoper_escalate", project.tag, audit.triggered_by_agent_id, audit.session_id,
      `Mode C: ${feature.id} has no clauses to plan`, { feature_id: feature.id, decision_queue_id: decId });
    const runId = await logStep(
      feature, project.tag, mode, 6, "emit_mode_c",
      { reason: "no_clauses_to_plan" },
      { outcome_mode: "C", decision_queue_id: decId, signal: "scoper_escalate" },
      audit, step4Id, Date.now(),
    );
    const resp: PlanResponse = {
      outcome_mode: "C",
      feature_id: feature.id,
      scoper_run_id: runId,
      dispatch_tree_id: null,
      decision_queue_id: decId,
      signal: "scoper_escalate",
    };
    return jsonResponse(resp, 200);
  }

  const waveOrg = organizeWaves(feature.id, decomposition.clauses);
  const _step5Id = await logStep(
    feature, project.tag, mode, 5, "wave_organization",
    { clause_count: decomposition.clauses.length },
    {
      feature_group: waveOrg.feature_group,
      wave_count: waveOrg.waves.length,
      total_clauses: waveOrg.total_clauses,
      critical_path_clauses: waveOrg.critical_path_clauses,
    },
    audit, step4Id, step5Start,
  );

  // ─── Step 6: emit Mode A ──────────────────────────────────────────────────

  const step6Start = Date.now();
  const dispatchTreeRow = {
    feature_id: feature.id,
    project: project.tag,
    scoper_run_id: step4Id,
    prior_plan_id: overrides.prior_plan_id ?? null,
    clauses: waveOrg.clauses,
    waves: waveOrg.waves,
    customer_experience: decomposition.customer_experience,
    preconditions: decomposition.preconditions,
    outcome_mode: "A" as const,
    ...(overrides.failure_context
      ? { delta_from_prior: { failure_context: overrides.failure_context, replanned_at: new Date().toISOString() } }
      : {}),
  };

  const dispatchTreeId = await insertDispatchTree(dispatchTreeRow);

  // ─── GAP 2 fix: Promote clauses + write ACs + trigger dispatch ────────────
  // Per grill decision 63b43107: Scoper flips both gates atomically at Mode A end.
  const clauseIdsToPromote = decomposition.clauses.map((c) => c.id);

  if (clauseIdsToPromote.length > 0) {
    const sb = getSupabaseClient();

    // 1. Write ACs + contract back to bible_clauses (LLM-enriched or generated)
    for (const clause of decomposition.clauses) {
      const updatePayload: Record<string, unknown> = {
        acceptance_criteria: clause.acceptance_criteria,
        updated_at: new Date().toISOString(),
      };
      // Only overwrite contract if LLM actually produced one
      if (clause.contract) {
        updatePayload.contract = clause.contract;
      }
      // deno-lint-ignore no-explicit-any
      await (sb as any)
        .from("bible_clauses")
        .update(updatePayload)
        .eq("id", clause.id);
    }

    // 2. Promote: status='active', approved_for_dispatch=true, maturity_stage='SCAFFOLD'
    // deno-lint-ignore no-explicit-any
    const { error: promoteErr } = await (sb as any)
      .from("bible_clauses")
      .update({
        status: "active",
        approved_for_dispatch: true,
        maturity_stage: "SCAFFOLD",
        updated_at: new Date().toISOString(),
      })
      .in("id", clauseIdsToPromote);

    if (promoteErr) {
      // Non-fatal: log but continue — dispatch_tree is already written
      await emitScoperSignal("scoper_promote_error", project.tag, audit.triggered_by_agent_id, audit.session_id,
        `Promotion failed: ${promoteErr.message}`, { clause_ids: clauseIdsToPromote, error: promoteErr.message });
    }

    // 3. Call POST /dispatch/tree to trigger workers
    // Use the NOUS edge function directly (same Supabase instance)
    try {
      const nousUrl = process.env.SUPABASE_URL ?? "https://oozlawunlkkuaykfunan.supabase.co";
      const nousKey = process.env.NOUS_API_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
      const dispatchResp = await fetch(`${nousUrl}/functions/v1/nous/dispatch/tree`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": nousKey,
        },
        body: JSON.stringify({
          project: project.tag,
          feature_id: feature.id,
          triggered_by_agent_id: "scoper-v3",
          session_id: audit.session_id,
        }),
      });
      const dispatchResult = await dispatchResp.text();
      if (!dispatchResp.ok) {
        await emitScoperSignal("scoper_dispatch_error", project.tag, audit.triggered_by_agent_id, audit.session_id,
          `Dispatch call failed: ${dispatchResp.status}`, { response: dispatchResult.slice(0, 300) });
      }
    } catch (err) {
      // Non-fatal: clauses are promoted, dispatch_tree row exists.
      // Manual dispatch can recover.
      await emitScoperSignal("scoper_dispatch_error", project.tag, audit.triggered_by_agent_id, audit.session_id,
        `Dispatch call error: ${(err as Error).message}`, { feature_id: feature.id });
    }
  }

  // Clear stale findings (we're in Mode A)
  await writeScoperFindings(feature.id, null, mode);
  await emitScoperSignal("scoper_plan_emitted", project.tag, audit.triggered_by_agent_id, audit.session_id,
    `Mode A: ${waveOrg.total_clauses} clauses across ${waveOrg.waves.length} waves — promoted + dispatched`,
    { feature_id: feature.id, dispatch_tree_id: dispatchTreeId, run_id: step4Id, promoted: clauseIdsToPromote.length });

  const runId = await logStep(
    feature, project.tag, mode, 6, "emit_mode_a",
    { clause_count: waveOrg.total_clauses, wave_count: waveOrg.waves.length },
    {
      outcome_mode: "A",
      dispatch_tree_id: dispatchTreeId,
      signal: "scoper_plan_emitted",
      clauses_promoted: clauseIdsToPromote.length,
      dispatch_triggered: true,
      generated: decomposition.generated,
      llm_enriched: !decomposition.generated && (decomposition.tokens_in ?? 0) > 0,
      total_tokens: (decomposition.tokens_in ?? 0) + (decomposition.tokens_out ?? 0),
    },
    audit, step4Id, step6Start,
  );

  const resp: PlanResponse = {
    outcome_mode: "A",
    feature_id: feature.id,
    scoper_run_id: runId,
    dispatch_tree_id: dispatchTreeId,
    dispatch_tree: dispatchTreeRow as unknown as Record<string, unknown>,
    signal: "scoper_plan_emitted",
    generated: decomposition.generated,
    clauses_promoted: clauseIdsToPromote.length,
    dispatch_triggered: true,
  };
  return jsonResponse(resp, 200);
}

// ─── Small helpers (kept local to plan.ts to keep _shared.ts lean) ──────────

function countVerifications(clauses: Array<{ acceptance_criteria: Array<{ verification: string }> }>): Record<string, number> {
  const out: Record<string, number> = { auto: 0, physical_qa: 0, kosta_review: 0 };
  for (const c of clauses) {
    for (const a of c.acceptance_criteria) {
      if (a.verification in out) out[a.verification] += 1;
    }
  }
  return out;
}

async function logStep(
  feature: FeatureRow,
  project: string,
  mode: "plan" | "replan",
  step: number,
  step_name: string,
  step_input: Record<string, unknown>,
  step_output: Record<string, unknown>,
  audit: AuditTrail,
  parent_run_id: string,
  start_ms: number,
  topLevelFields?: Partial<{
    model_used: string;
    tokens_in: number;
    tokens_out: number;
    estimated_cost_usd: number;
  }>,
): Promise<string> {
  return await writeScoperStep({
    feature_id: feature.id,
    project,
    mode,
    step,
    step_name,
    step_input,
    step_output,
    org_id: audit.org_id,
    triggered_by_agent_id: audit.triggered_by_agent_id,
    session_id: audit.session_id,
    parent_run_id,
    duration_ms: Date.now() - start_ms,
    ...(topLevelFields ?? {}),
  });
}
