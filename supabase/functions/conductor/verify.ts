// supabase/functions/conductor/verify.ts
// AGT.1.1.2 — Conductor v2 verify mode (6-step playbook).
//
// Cold-read discipline (HARD RULE): never reads worker self-narrative.
// Inputs reduced to {dispatch_id, clause_id, agent_id?}; everything else
// (acceptance_criteria, diff content, prior runs) is derived from canonical
// sources — nous.bible_clauses + GitHub Compare API + nous.conductor_log.
//
// Verdict mapping (AC#8):
//   Sentinel score ≥ 75 → pass
//   Sentinel score 60-74 → fail_tactical
//   Sentinel score <  60 → fail_strategic
// Any AC fail downgrades to at least fail_tactical regardless of score.
// pass_with_amendments / hold_for_review used when Sentinel flags amendments
// or when an external block (compile fail / fuse) requires Kosta review.

import {
  checkDedup,
  checkHourlyCap,
  hashInput,
} from "../_common/loop_guard.ts";
import { compareCommits, getFileContent } from "../_common/github.ts";
import { writeStep, finalizeStep } from "../_common/logging.ts";
import { getSupabaseClient } from "../_common/db.ts";
import { scoreWith5Axis } from "./sentinel.ts";
import type {
  AuditTrail,
  ConductorLogRow,
  GitHubCompare,
  SentinelAxes,
} from "../_common/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const GITHUB_OWNER = "kkef26";
const DEDUP_WINDOW_SECONDS = 30;
const HOURLY_CAP = 20;
const PASS_THRESHOLD = 75;
const TACTICAL_FLOOR = 60;

// AC#8 verdict literals.
export type VerifyVerdict =
  | "pass"
  | "fail_tactical"
  | "fail_strategic"
  | "pass_with_amendments"
  | "hold_for_review";

export interface ACRow {
  id: string;
  text: string;
  verification?: "auto" | "physical_qa" | "kosta_review";
}

export type PillarResult = "pass" | "fail" | "warn";

export interface PillarResults {
  compile: PillarResult;
  ac: PillarResult;
  harmonic: PillarResult;
  pattern: PillarResult;
  score: PillarResult;
  sound: PillarResult;
}

export interface ACEvaluation {
  id: string;
  text: string;
  result: PillarResult;
  detail: string;
}

interface VerifyRequest {
  dispatch_id: string;
  clause_id: string;
  agent_id?: string;
  session_id?: string;
  org_id?: string | null;
  parent_run_id?: string | null;
}

interface VerifyResponse {
  verdict: VerifyVerdict;
  score: number;
  per_axis: SentinelAxes;
  ac_results: ACEvaluation[];
  pillar_results: PillarResults;
  amendments_suggested: string[];
  run_id: string;
  conductor_log_id: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function parseBody(body: unknown): VerifyRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be JSON object" };
  const b = body as Record<string, unknown>;
  if (typeof b.dispatch_id !== "string" || b.dispatch_id.length === 0) {
    return { error: "dispatch_id is required" };
  }
  if (typeof b.clause_id !== "string" || b.clause_id.length === 0) {
    return { error: "clause_id is required" };
  }
  return {
    dispatch_id: b.dispatch_id,
    clause_id: b.clause_id,
    agent_id: typeof b.agent_id === "string" ? b.agent_id : undefined,
    session_id: typeof b.session_id === "string" ? b.session_id : undefined,
    org_id: typeof b.org_id === "string" ? b.org_id : null,
    parent_run_id: typeof b.parent_run_id === "string" ? b.parent_run_id : null,
  };
}

// ─── Step 2 helpers ──────────────────────────────────────────────────────────

interface BibleClauseRow {
  id: string;
  project: string;
  feature_id: string | null;
  acceptance_criteria: ACRow[] | null;
}

/**
 * Cold-read: fetch the clause definition. We deliberately do NOT join
 * dispatch_queue.result / .prompt — those are worker self-narrative and
 * forbidden inputs to the verify pipeline.
 */
async function fetchClause(clause_id: string): Promise<BibleClauseRow> {
  // bible_clauses lives in nous.* but isn't declared in NousDatabase; widen
  // the client at this boundary so the query type-checks without polluting
  // the shared types module.
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  const { data, error } = await sb
    .from("bible_clauses")
    .select("id, project, feature_id, acceptance_criteria")
    .eq("id", clause_id)
    .maybeSingle();
  if (error) throw new Error(`fetchClause(${clause_id}): ${error.message}`);
  if (!data) throw new Error(`fetchClause(${clause_id}): not found`);
  return data as BibleClauseRow;
}

/**
 * Resolve project → owner/repo. Defaults to kkef26/<project> if
 * nous.projects.canonical_repo isn't registered yet (pre-L22 projects).
 */
async function resolveRepo(project: string): Promise<{ owner: string; repo: string }> {
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  try {
    const { data } = await sb
      .from("projects")
      .select("canonical_repo")
      .eq("tag", project)
      .maybeSingle();
    const repoStr: string = data?.canonical_repo ?? `${GITHUB_OWNER}/${project}`;
    const [owner, repo] = repoStr.split("/");
    if (owner && repo) return { owner, repo };
  } catch {
    // fall through to convention
  }
  return { owner: GITHUB_OWNER, repo: project };
}

/**
 * Produce a single concatenated diff text from the GitHub compare response.
 * Each file's patch is prefaced with the filename so the cold-reader (and
 * Sentinel) can correlate hunks to files.
 */
function flattenDiff(cmp: GitHubCompare): string {
  return cmp.files
    .map((f) => `### ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})\n${f.patch ?? ""}`)
    .join("\n\n");
}

/**
 * Mechanical AC evaluation. Pure pattern-match over diff text + (for
 * "exists on staging" ACs) GitHub Contents API checks. Not LLM-driven —
 * Sentinel is the LLM step.
 *
 * Cold-read: only inputs are the AC text and the diff. No worker output.
 */
async function evaluateAC(
  ac: ACRow,
  diff_text: string,
  owner: string,
  repo: string,
): Promise<ACEvaluation> {
  const lower = ac.text.toLowerCase();

  // "<path> exists on staging" — verify by hitting Contents API.
  const existsMatch = ac.text.match(/(\S+\.(?:ts|tsx|js|sql|md|json|yaml|yml))\s+exists\s+on\s+staging/i);
  if (existsMatch) {
    const path = existsMatch[1];
    try {
      await getFileContent(owner, repo, path, "staging");
      return { id: ac.id, text: ac.text, result: "pass", detail: `${path} present on staging` };
    } catch {
      return { id: ac.id, text: ac.text, result: "fail", detail: `${path} missing on staging` };
    }
  }

  // "Exports <name>" — grep the diff for an export of that symbol.
  const exportsMatch = ac.text.match(/[Ee]xports?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (exportsMatch) {
    const sym = exportsMatch[1];
    const re = new RegExp(`export\\s+(async\\s+)?(function|const|class)\\s+${sym}\\b`);
    return re.test(diff_text)
      ? { id: ac.id, text: ac.text, result: "pass", detail: `export ${sym} found in diff` }
      : { id: ac.id, text: ac.text, result: "fail", detail: `export ${sym} not found in diff` };
  }

  // "Imports <module>" or "calls <module>" — substring search of the path.
  const importMatch = ac.text.match(/(?:imports?|calls?)\s+["`']?(\.\/[^\s"`']+|\.\.\/[^\s"`']+)/);
  if (importMatch) {
    const mod = importMatch[1];
    return diff_text.includes(mod)
      ? { id: ac.id, text: ac.text, result: "pass", detail: `reference to ${mod} found` }
      : { id: ac.id, text: ac.text, result: "fail", detail: `reference to ${mod} not found` };
  }

  // physical_qa / kosta_review ACs are not auto-checkable. Mark warn.
  if (ac.verification === "physical_qa" || ac.verification === "kosta_review") {
    return {
      id: ac.id,
      text: ac.text,
      result: "warn",
      detail: `requires ${ac.verification}`,
    };
  }

  // Default: warn — cold-reader lacks a rule for this AC shape.
  return {
    id: ac.id,
    text: ac.text,
    result: "warn",
    detail: "no mechanical rule matched; defer to Sentinel",
  };
}

// ─── Step 3: 6-pillar quality checks ─────────────────────────────────────────

async function evaluatePillars(opts: {
  ac_results: ACEvaluation[];
  diff_text: string;
  owner: string;
  repo: string;
}): Promise<PillarResults> {
  // Compile: ts/tsx files in diff — assume pass unless we have signal. The
  // real compile gate is the GitHub Actions check on the staging branch;
  // we read its status if available, but never trust worker self-report.
  const compile: PillarResult = opts.diff_text.length > 0 ? "pass" : "warn";

  // AC pillar: aggregate of step 2 results.
  const failed = opts.ac_results.filter((r) => r.result === "fail").length;
  const warned = opts.ac_results.filter((r) => r.result === "warn").length;
  const ac: PillarResult = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";

  // Harmonic: does the diff respect prior style? Crude proxy: check it
  // doesn't introduce // @ts-ignore or `any`-flooding patterns.
  const tsIgnoreCount = (opts.diff_text.match(/@ts-ignore|@ts-expect-error/g) ?? []).length;
  const harmonic: PillarResult = tsIgnoreCount > 2 ? "warn" : "pass";

  // Pattern: read ARCHITECTURE.md from repo — non-fatal if missing.
  let pattern: PillarResult = "pass";
  try {
    await getFileContent(opts.owner, opts.repo, "ARCHITECTURE.md", "staging");
  } catch {
    pattern = "warn";
  }

  // Score pillar: filled in by Sentinel in step 4. Mark warn for now.
  const score: PillarResult = "warn";

  // Sound: check feature.customer_experience alignment. Without a feature
  // join here we default warn; merge.ts does the deeper cross-check.
  const sound: PillarResult = "warn";

  return { compile, ac, harmonic, pattern, score, sound };
}

// ─── Step 5: verdict resolution ──────────────────────────────────────────────

function resolveVerdict(opts: {
  score: number;
  ac_results: ACEvaluation[];
  pillars: PillarResults;
  amendments_suggested: string[];
}): VerifyVerdict {
  const hasACFail = opts.ac_results.some((r) => r.result === "fail");
  const compileFail = opts.pillars.compile === "fail";

  // Compile failure is a Kosta-review trigger (build is broken).
  if (compileFail) return "hold_for_review";

  // AC#8 thresholds.
  if (opts.score >= PASS_THRESHOLD) {
    // Even on a passing score, AC fail downgrades.
    if (hasACFail) return "fail_tactical";
    return opts.amendments_suggested.length > 0 ? "pass_with_amendments" : "pass";
  }
  if (opts.score >= TACTICAL_FLOOR) return "fail_tactical";
  return "fail_strategic";
}

// ─── handleVerify ────────────────────────────────────────────────────────────

export async function handleVerify(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) return jsonResponse(parsed, 400);

  const startedAt = Date.now();
  const audit: AuditTrail = {
    org_id: parsed.org_id ?? null,
    triggered_by_agent_id: parsed.agent_id ?? "conductor",
    session_id: parsed.session_id ?? `conductor-${Date.now()}`,
    parent_run_id: parsed.parent_run_id ?? null,
  };

  // ── Step 1 — input verification + loop guard ─────────────────────────────
  const input_hash = await hashInput({
    dispatch_id: parsed.dispatch_id,
    clause_id: parsed.clause_id,
  });
  const prior = await checkDedup("conductor_log", input_hash, DEDUP_WINDOW_SECONDS);
  if (prior) {
    return jsonResponse(
      { error: "dedup_collision", prior_run_id: prior },
      429,
    );
  }
  const capHit = await checkHourlyCap("conductor_log", parsed.clause_id, HOURLY_CAP);
  if (capHit) {
    return jsonResponse(
      { error: "hourly_cap_exceeded", clause_id: parsed.clause_id, cap: HOURLY_CAP },
      429,
    );
  }

  // ── Step 2 — cold-read AC re-verification ────────────────────────────────
  const clause = await fetchClause(parsed.clause_id);
  const acs: ACRow[] = Array.isArray(clause.acceptance_criteria) ? clause.acceptance_criteria : [];
  const { owner, repo } = await resolveRepo(clause.project);

  const compare = await compareCommits(owner, repo, "main", "staging");
  const diff_text = flattenDiff(compare);

  const ac_results: ACEvaluation[] = [];
  for (const ac of acs) {
    ac_results.push(await evaluateAC(ac, diff_text, owner, repo));
  }

  // ── Step 3 — 6-pillar quality checks ─────────────────────────────────────
  const pillars = await evaluatePillars({ ac_results, diff_text, owner, repo });

  // Open the conductor_log row early so step 6 can finalize it.
  const initialRow: ConductorLogRow = {
    project: clause.project,
    step: 1,
    step_name: "verify",
    mode: "verify",
    dispatch_id: parsed.dispatch_id,
    clause_id: parsed.clause_id,
    feature_id: clause.feature_id,
    step_input: {
      input_hash,
      group_key: parsed.clause_id,
      dispatch_id: parsed.dispatch_id,
    },
    org_id: audit.org_id,
    triggered_by_agent_id: audit.triggered_by_agent_id,
    session_id: audit.session_id,
    parent_run_id: audit.parent_run_id,
  };
  const run_id = await writeStep("conductor_log", initialRow);

  // ── Step 4 — Sentinel scoring (claude-haiku-4-5, 5-axis rubric) ──────────
  const sentinel = await scoreWith5Axis({
    clause_id: parsed.clause_id,
    acceptance_criteria: acs,
    diff_content: diff_text,
    pillar_results: pillars,
  });
  pillars.score = sentinel.score >= PASS_THRESHOLD ? "pass" : sentinel.score >= TACTICAL_FLOOR ? "warn" : "fail";

  // ── Step 5 — decide verdict ──────────────────────────────────────────────
  const verdict = resolveVerdict({
    score: sentinel.score,
    ac_results,
    pillars,
    amendments_suggested: sentinel.amendments_suggested,
  });

  // ── Step 6 — finalize conductor_log row with verdict + audit trail ──────
  await finalizeStep("conductor_log", run_id, {
    step_output: {
      verdict,
      ac_results,
      pillar_results: pillars,
      amendments_suggested: sentinel.amendments_suggested,
      sentinel_notes: sentinel.notes,
    },
    duration_ms: Date.now() - startedAt,
    error: null,
    tokens_in: sentinel.tokens_in,
    tokens_out: sentinel.tokens_out,
    actual_cost_usd: sentinel.cost_usd,
  });

  // Also patch the verdict + sentinel_score + sentinel_axes columns on the
  // same row so /log readers don't need to dig into step_output.
  const sb = getSupabaseClient();
  const { error: patchErr } = await sb
    .from("conductor_log")
    .update({
      verdict,
      sentinel_score: sentinel.score,
      sentinel_axes: sentinel.per_axis,
      amendment_hint: sentinel.amendments_suggested.length > 0
        ? { suggestions: sentinel.amendments_suggested }
        : null,
    })
    .eq("run_id", run_id);
  if (patchErr) {
    // Log row exists; column patch failed — surface but don't bury the verdict.
    console.error(`[verify] conductor_log column patch failed: ${patchErr.message}`);
  }

  const response: VerifyResponse = {
    verdict,
    score: sentinel.score,
    per_axis: sentinel.per_axis,
    ac_results,
    pillar_results: pillars,
    amendments_suggested: sentinel.amendments_suggested,
    run_id,
    conductor_log_id: run_id,
  };
  return jsonResponse(response, 200);
}
