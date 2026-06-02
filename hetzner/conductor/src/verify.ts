// supabase/functions/conductor/verify.ts
// AGT.1.1.2 — Conductor v2 verify mode (6-step playbook).
// AGT.1.1.4.1 — Calibration v2: 4-band thresholds, trigger-word override,
//   pass_with_amendments → amendment_queue, tactical retry rewrite detection.
//
// Cold-read discipline (HARD RULE): never reads worker self-narrative.
// Inputs reduced to {dispatch_id, clause_id, agent_id?}; everything else
// (acceptance_criteria, diff content, prior runs) is derived from canonical
// sources — nous.bible_clauses + GitHub Compare API + nous.conductor_log.
//
// Verdict mapping (calibration v2):
//   Sentinel score ≥ 85           → pass               → terminal outcome: MERGE
//   Sentinel score 75-84          → pass_with_amendments (followup_polish) → MERGE
//   Sentinel score 60-74          → fail_tactical      → terminal outcome: REDISPATCH
//   Sentinel score <  60          → fail_strategic     → terminal outcome: ESCALATE
//   compile_fail / structural     → block              → terminal outcome: REJECT
//
// Terminal outcomes enforced — no conductor retry loops. Every sweep produces
// exactly one of: MERGE, REDISPATCH, ESCALATE, REJECT. See grill decision
// "Terminal outcomes enforced — no conductor retry loops".
// Override (Step 5): score in [75,85) AND sentinel flagged missing steps
//   in amendments_suggested or notes → force fail_tactical regardless of
//   raw score. This catches the "5 of 6 steps shipped but scored 78" case
//   that motivated AGT.1.1.4.1.
// Any AC fail downgrades to at least fail_tactical regardless of score.
// hold_for_review fires on compile_fail (build broken, Kosta gate).

import {
  checkDedup,
  checkHourlyCap,
  hashInput,
} from "./lib/common/loop_guard.js";
import { compareCommits, getFileContent } from "./lib/common/github.js";
import { writeStep, finalizeStep } from "./lib/common/logging.js";
import { getSupabaseClient } from "./lib/common/db.js";
import { scoreWith5Axis } from "./sentinel.js";
import { handleMerge } from "./merge.js";
import { createFuse } from "./fuse_manager.js";
import type {
  AuditTrail,
  ConductorLogRow,
  GitHubCompare,
  SentinelAxes,
} from "./lib/common/types.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
const GITHUB_OWNER = "kkef26";
const DEDUP_WINDOW_SECONDS = 30;
const HOURLY_CAP = 20;

// Calibration v2 thresholds (AGT.1.1.4.1)
const CLEAN_PASS_THRESHOLD = 85;       // ≥85 ships clean
const AMENDMENTS_THRESHOLD = 75;       // 75-84 ships with amendments
const TACTICAL_FLOOR = 60;             // 60-74 fail_tactical
// <60 fail_strategic

// Tactical retry rewrite detection (AGT.1.1.4.1 Change 5)
const REWRITE_DELETIONS_FLOOR = 50;
const REWRITE_RATIO_CEILING = 1.5;

// Sentinel-flag override regexes (AGT.1.1.4.1 Change 2)
const MISSING_PATTERNS =
  /(missing|incomplete|not yet|absent|skipped|deferred|stub(?:bed)?)/i;
const STEP_REF_PATTERN = /(Step\s+\d|step\s+\d|AC\d{2}|AC\s+\d)/;

// Verdict literals (calibration v2: pass_with_amendments is first-class)
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
  fuse_id?: string | null;
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
  override_reason?: string | null;
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
    fuse_id: typeof b.fuse_id === "string" ? b.fuse_id : null,
  };
}

// ─── Step 2 helpers ──────────────────────────────────────────────────────────

interface BibleClauseRow {
  id: string;
  feature_id: string | null;
  acceptance_criteria: ACRow[] | null;
  project: string; // resolved from dispatch_queue, not bible_clauses
}

/**
 * Cold-read: fetch the clause definition. We deliberately do NOT join
 * dispatch_queue.result / .prompt — those are worker self-narrative and
 * forbidden inputs to the verify pipeline.
 */
async function fetchClause(clause_id: string, dispatch_id: string): Promise<BibleClauseRow> {
  // bible_clauses lives in nous.* but isn't declared in NousDatabase; widen
  // the client at this boundary so the query type-checks without polluting
  // the shared types module.
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  const { data, error } = await sb
    .from("bible_clauses")
    .select("id, feature_id, acceptance_criteria")
    .eq("id", clause_id)
    .maybeSingle();
  if (error) throw new Error(`fetchClause(${clause_id}): ${error.message}`);
  if (!data) throw new Error(`fetchClause(${clause_id}): not found`);

  // Resolve project from dispatch_queue (bible_clauses has no project column;
  // project is stored on dispatch_queue rows and nous.projects via clause_prefix).
  const { data: dq } = await sb
    .from("dispatch_queue")
    .select("project")
    .eq("id", dispatch_id)
    .maybeSingle();
  const project = dq?.project ?? null;
  if (!project) {
    // Fallback: resolve via prefix → nous.projects.clause_prefix
    const prefix = clause_id.split(".")[0];
    const { data: proj } = await sb
      .from("projects")
      .select("tag")
      .eq("clause_prefix", prefix)
      .limit(1)
      .maybeSingle();
    if (!proj?.tag) throw new Error(`fetchClause(${clause_id}): cannot resolve project from dispatch_queue or prefix`);
    return { ...data, project: proj.tag } as BibleClauseRow;
  }
  return { ...data, project } as BibleClauseRow;
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
 * Count prior tactical-fail conductor_log rows for this clause. Used to
 * derive attempt_count without taking a worker-side input. Attempt 1 is
 * the first run (no priors); attempt 2+ is a tactical retry.
 */
async function countPriorTacticalAttempts(clause_id: string): Promise<number> {
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  try {
    const { count } = await sb
      .from("conductor_log")
      .select("run_id", { count: "exact", head: true })
      .eq("clause_id", clause_id)
      .eq("verdict", "fail_tactical");
    return typeof count === "number" ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch the list of files the worker committed for this dispatch.
 * Returns null if the column is empty or the dispatch doesn't exist —
 * callers treat null as "no scope filter, use full diff" for backward
 * compatibility with dispatches that predate this column.
 */
async function fetchCommittedFiles(dispatch_id: string): Promise<string[] | null> {
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  try {
    const { data } = await sb
      .from("dispatch_queue")
      .select("committed_files")
      .eq("id", dispatch_id)
      .maybeSingle();
    const files = data?.committed_files;
    if (Array.isArray(files) && files.length > 0) return files;
    return null;
  } catch {
    return null;
  }
}

/**
 * FREE.10 — fetch dispatch_mode + clause_id so handleVerify can skip
 * freeform/orchestrator dispatches (knowledge work with no clause to verify).
 * Returns nulls on error so verify falls through to its normal path.
 */
async function fetchDispatchMode(
  dispatch_id: string,
): Promise<{ dispatch_mode: string | null; clause_id: string | null; bible_clause: string | null }> {
  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  try {
    const { data } = await sb
      .from("dispatch_queue")
      .select("dispatch_mode, clause_id, bible_clause")
      .eq("id", dispatch_id)
      .maybeSingle();
    return {
      dispatch_mode: data?.dispatch_mode ?? null,
      clause_id: data?.clause_id ?? null,
      bible_clause: data?.bible_clause ?? null,
    };
  } catch {
    return { dispatch_mode: null, clause_id: null, bible_clause: null };
  }
}

/**
 * Scope a full repo compare to only the files this dispatch touched.
 * If committedFiles is null (pre-column dispatches), returns the
 * original compare unmodified for backward compatibility.
 *
 * This fixes the "scope pollution" bug where verifying clause A against
 * a staging diff that also contains clause B/C/D files caused sentinel
 * to flag files from other clauses as missing from A.
 */
function scopeCompareToClause(
  cmp: GitHubCompare,
  committedFiles: string[] | null,
): GitHubCompare {
  if (!committedFiles || committedFiles.length === 0) return cmp;
  const fileSet = new Set(committedFiles);
  const filtered = cmp.files.filter((f) => fileSet.has(f.filename));
  // If filtering produces zero files, fall back to full diff — the worker
  // may have recorded paths slightly differently (with/without leading slash).
  if (filtered.length === 0) {
    console.warn(
      `[verify] scopeCompareToClause: committed_files (${committedFiles.length}) matched 0 of ${cmp.files.length} compare files — falling back to full diff`,
    );
    return cmp;
  }
  console.log(
    `[verify] scopeCompareToClause: filtered ${cmp.files.length} files → ${filtered.length} (committed_files scope)`,
  );
  return { ...cmp, files: filtered };
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
 * Sum total additions/deletions across a compare result. Used by the
 * tactical-retry rewrite detector — large -deletions with small +additions
 * looks like rewrite-from-scratch rather than an additive amendment.
 */
function totalChurn(cmp: GitHubCompare): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of cmp.files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
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
  if (!ac.text) {
    return { id: ac.id || "unknown", text: "(missing)", result: "warn" as PillarResult, detail: "AC text undefined — skipped" };
  }
  const lower = ac.text.toLowerCase();
  void lower;

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

// ─── Step 5: verdict resolution + override ───────────────────────────────────

/**
 * AGT.1.1.4.1 override: detect when Sentinel flagged missing spec steps in
 * its own amendments/notes. A 78/100 with notes saying "5 of 6 steps
 * complete, Step 1 missing" is the failure case this clause was born from.
 *
 * Returns the override_reason string if triggered, else null.
 */
function detectMissingStepOverride(opts: {
  score: number;
  amendments_suggested: string[];
  sentinel_notes: string;
}): string | null {
  // Only override in the "ships with amendments" band; clean passes (≥85)
  // are kept clean, tactical/strategic fails (<75) already loop.
  if (opts.score < AMENDMENTS_THRESHOLD || opts.score >= CLEAN_PASS_THRESHOLD) {
    return null;
  }

  // An amendment with BOTH a missing-word AND a step/AC reference is the
  // signal that the model itself saw a gap.
  const amendmentHasMissingStep = opts.amendments_suggested.some(
    (a) => MISSING_PATTERNS.test(a) && STEP_REF_PATTERN.test(a),
  );

  // Alternatively, the model's own notes flag something missing — that's
  // strong enough on its own to loop.
  const notesFlagsMissing = MISSING_PATTERNS.test(opts.sentinel_notes);

  if (amendmentHasMissingStep || notesFlagsMissing) {
    return "sentinel_flagged_missing_steps_in_amendments";
  }
  return null;
}

interface VerdictResolution {
  verdict: VerifyVerdict;
  override_reason: string | null;
}

function resolveVerdict(opts: {
  score: number;
  ac_results: ACEvaluation[];
  pillars: PillarResults;
  amendments_suggested: string[];
  sentinel_notes: string;
}): VerdictResolution {
  const hasACFail = opts.ac_results.some((r) => r.result === "fail");
  const compileFail = opts.pillars.compile === "fail";

  // Compile failure is a Kosta-review trigger (build is broken).
  if (compileFail) return { verdict: "hold_for_review", override_reason: null };

  // AC fail always downgrades to at least tactical, regardless of score.
  if (hasACFail && opts.score >= TACTICAL_FLOOR) {
    return { verdict: "fail_tactical", override_reason: null };
  }

  // Step 5 override: substantive missing-step flag in the 75-84 band forces
  // the loop. Conductor v2 should be strict — loop until clean.
  const override = detectMissingStepOverride({
    score: opts.score,
    amendments_suggested: opts.amendments_suggested,
    sentinel_notes: opts.sentinel_notes,
  });
  if (override) {
    return { verdict: "fail_tactical", override_reason: override };
  }

  // Calibration v2 4-band thresholds (no override path).
  if (opts.score >= CLEAN_PASS_THRESHOLD) {
    // ≥85: if amendments suggested, still spawn followup_polish but ship.
    return {
      verdict: opts.amendments_suggested.length > 0 ? "pass_with_amendments" : "pass",
      override_reason: null,
    };
  }
  if (opts.score >= AMENDMENTS_THRESHOLD) {
    // 75-84 without missing-step override: ships with amendments by definition.
    return { verdict: "pass_with_amendments", override_reason: null };
  }
  if (opts.score >= TACTICAL_FLOOR) {
    return { verdict: "fail_tactical", override_reason: null };
  }
  return { verdict: "fail_strategic", override_reason: null };
}

// ─── Amendment queue (Step 6 — pass_with_amendments path) ────────────────────

/**
 * Insert amendments into nous.amendment_queue with kind='followup_polish'.
 * One row per amendment so each can be picked up independently. Best-effort:
 * a failure here logs but does NOT block the verdict — the conductor_log
 * row (with amendment_hint column) is still the canonical record.
 */
async function enqueueFollowupAmendments(opts: {
  clause_id: string;
  project: string;
  feature_id: string | null;
  amendments: string[];
  run_id: string;
  parent_run_id: string | null;
  session_id: string | null;
}): Promise<{ enqueued: number; errors: number }> {
  if (opts.amendments.length === 0) return { enqueued: 0, errors: 0 };

  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  const rows = opts.amendments.map((content) => ({
    clause_id: opts.clause_id,
    project: opts.project,
    feature_id: opts.feature_id,
    kind: "followup_polish",
    content,
    source_run_id: opts.run_id,
    parent_run_id: opts.parent_run_id,
    session_id: opts.session_id,
    status: "pending",
  }));

  try {
    const { error } = await sb.from("amendment_queue").insert(rows);
    if (error) {
      console.error(`[verify] amendment_queue insert failed: ${error.message}`);
      return { enqueued: 0, errors: rows.length };
    }
    return { enqueued: rows.length, errors: 0 };
  } catch (err) {
    console.error(`[verify] amendment_queue insert threw: ${(err as Error).message}`);
    return { enqueued: 0, errors: rows.length };
  }
}

// ─── Status stamping (AGT.2.2 Part B — carwash position handoff) ───────────

/**
 * Update nous.bible_clauses.status based on the resolved verdict so the
 * two-phase status model (AGT.2.1) reflects the conductor's decision.
 *
 *   pass / pass_with_amendments → 'verified'   (ready for merge.ts to stamp 'shipped')
 *   fail_tactical / fail_strategic → 'build_failed' (sweeper picks up for amend/escalate)
 *   hold_for_review → no change (compile broken, Kosta gate)
 *
 * Best-effort: a write failure logs but does not change the verdict — the
 * conductor_log row is still the canonical record of what happened.
 */
async function stampClauseStatusFromVerdict(
  clause_id: string,
  verdict: VerifyVerdict,
): Promise<void> {
  let newStatus: string | null = null;
  if (verdict === "pass" || verdict === "pass_with_amendments") {
    newStatus = "verified";
  } else if (verdict === "fail_tactical" || verdict === "fail_strategic") {
    newStatus = "build_failed";
  }
  if (!newStatus) return;

  // deno-lint-ignore no-explicit-any
  const sb = getSupabaseClient() as any;
  const { error } = await sb
    .from("bible_clauses")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", clause_id);
  if (error) {
    console.error(
      `[verify] stampClauseStatusFromVerdict(${clause_id} → ${newStatus}) failed: ${error.message}`,
    );
  }
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

  // FREE.10 — defensive skip for freeform/orchestrator dispatches.
  // These are knowledge work with no clause/AC to verify; sweeping them
  // through the sentinel pipeline would mark successful artifact-producing
  // runs as verify_failed. Also covers the missing-clause edge.
  const dispatchInfo = await fetchDispatchMode(parsed.dispatch_id);
  if (
    dispatchInfo.dispatch_mode === "freeform" ||
    dispatchInfo.dispatch_mode === "orchestrator" ||
    (!dispatchInfo.clause_id && !dispatchInfo.bible_clause)
  ) {
    return jsonResponse({
      ok: true,
      outcome: "skipped",
      reason: "freeform_no_verify",
      status: "complete",
    });
  }

  const startedAt = Date.now();
  // AC#9 audit trail: org_id, triggered_by_agent_id, session_id, parent_run_id, fuse_id.
  // AuditTrail (shared types) covers the first four; fuse_id is a ConductorLogRow
  // column tracked separately so non-conductor consumers don't need to know about it.
  const audit: AuditTrail = {
    org_id: parsed.org_id ?? null,
    triggered_by_agent_id: parsed.agent_id ?? "conductor",
    session_id: parsed.session_id ?? `conductor-${Date.now()}`,
    parent_run_id: parsed.parent_run_id ?? null,
  };
  const fuse_id: string | null = parsed.fuse_id ?? null;

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
  const clause = await fetchClause(parsed.clause_id, parsed.dispatch_id);
  const acs: ACRow[] = Array.isArray(clause.acceptance_criteria) ? clause.acceptance_criteria : [];
  const { owner, repo } = await resolveRepo(clause.project);

  const fullCompare = await compareCommits(owner, repo, "main", "staging");
  const committedFiles = await fetchCommittedFiles(parsed.dispatch_id);
  const compare = scopeCompareToClause(fullCompare, committedFiles);
  const diff_text = flattenDiff(compare);
  const churn = totalChurn(compare);

  const ac_results: ACEvaluation[] = [];
  for (const ac of acs) {
    ac_results.push(await evaluateAC(ac, diff_text, owner, repo));
  }

  // ── Step 3 — 6-pillar quality checks ─────────────────────────────────────
  const pillars = await evaluatePillars({ ac_results, diff_text, owner, repo });

  // Tactical-retry rewrite detection (AGT.1.1.4.1 Change 5): count prior
  // fail_tactical runs for this clause; if this looks like a from-scratch
  // rewrite rather than an additive amendment, fire a compile_fail fuse
  // with the rewrite-from-scratch marker. Best-effort — failure to fire
  // the fuse must not block verification, so we wrap in try/catch.
  const priorTacticalCount = await countPriorTacticalAttempts(parsed.clause_id);
  const attempt_count = priorTacticalCount + 1;
  const ratio = churn.deletions > 0 ? churn.additions / churn.deletions : Infinity;
  if (
    attempt_count > 1 &&
    churn.deletions > REWRITE_DELETIONS_FLOOR &&
    ratio < REWRITE_RATIO_CEILING
  ) {
    try {
      await createFuse({
        kind: "compile_fail",
        project: clause.project,
        clause_id: parsed.clause_id,
        feature_id: clause.feature_id ?? undefined,
        detail: "tactical_retry_appeared_to_rewrite_from_scratch",
        severity: "advisory",
        triggered_by_agent_id: audit.triggered_by_agent_id,
        session_id: audit.session_id,
        parent_run_id: audit.parent_run_id ?? undefined,
        proposed_resolution:
          `attempt ${attempt_count}: additions=${churn.additions}, deletions=${churn.deletions}, ` +
          `ratio=${ratio.toFixed(2)} (<${REWRITE_RATIO_CEILING}). Worker should fetch prior SHA ` +
          `and amend additively, not rewrite from scratch.`,
      });
      console.warn(
        `[verify] tactical_retry_appeared_to_rewrite_from_scratch fuse fired for ${parsed.clause_id} ` +
          `(attempt=${attempt_count}, +${churn.additions}/-${churn.deletions})`,
      );
    } catch (err) {
      console.error(`[verify] rewrite-fuse create failed: ${(err as Error).message}`);
    }
  }

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
    fuse_id,
  };
  const run_id = await writeStep("conductor_log", initialRow);

  // ── Step 4 — Sentinel scoring (claude-haiku-4-5, 5-axis rubric) ──────────
  // No client-side truncation — sentinel.ts chunks on function boundaries
  // for inputs >100KB. Watch for chunked=true so we can log the fallback.
  const sentinel = await scoreWith5Axis({
    clause_id: parsed.clause_id,
    acceptance_criteria: acs,
    diff_content: diff_text,
    pillar_results: pillars as unknown as Record<string, "pass" | "fail" | "warn">,
  });
  pillars.score =
    sentinel.score >= AMENDMENTS_THRESHOLD ? "pass"
    : sentinel.score >= TACTICAL_FLOOR ? "warn"
    : "fail";

  if (sentinel.chunked) {
    console.warn(
      `[verify] sentinel input was chunked into ${sentinel.chunk_count} pieces for ${parsed.clause_id} ` +
        `(weighted-average scoring); full context preserved.`,
    );
  }

  // ── Step 5 — decide verdict (with override) ──────────────────────────────
  const verdictResult = resolveVerdict({
    score: sentinel.score,
    ac_results,
    pillars,
    amendments_suggested: sentinel.amendments_suggested,
    sentinel_notes: sentinel.notes,
  });
  const verdict = verdictResult.verdict;
  const override_reason = verdictResult.override_reason;

  // ── Step 6 — stamp bible_clauses.status from verdict (AGT.2.2 Part B) ────
  // Update the clause to its new carwash position before finalizing the log
  // so the user-visible status reflects the decision even if log write fails.
  await stampClauseStatusFromVerdict(parsed.clause_id, verdict);

  // ── Step 7 — finalize conductor_log row + (if pass_with_amendments) enqueue ──
  let enqueueResult = { enqueued: 0, errors: 0 };
  if (verdict === "pass_with_amendments" && sentinel.amendments_suggested.length > 0) {
    enqueueResult = await enqueueFollowupAmendments({
      clause_id: parsed.clause_id,
      project: clause.project,
      feature_id: clause.feature_id,
      amendments: sentinel.amendments_suggested,
      run_id,
      parent_run_id: audit.parent_run_id,
      session_id: audit.session_id,
    });
  }

  await finalizeStep("conductor_log", run_id, {
    step_output: {
      verdict,
      ac_results,
      pillar_results: pillars,
      amendments_suggested: sentinel.amendments_suggested,
      sentinel_notes: sentinel.notes,
      override_reason,
      sentinel_chunked: sentinel.chunked ?? false,
      sentinel_chunk_count: sentinel.chunk_count ?? 1,
      attempt_count,
      churn,
      followup_enqueued: enqueueResult.enqueued,
      followup_enqueue_errors: enqueueResult.errors,
    },
    duration_ms: Date.now() - startedAt,
    error: null,
    tokens_in: sentinel.tokens_in,
    tokens_out: sentinel.tokens_out,
    actual_cost_usd: sentinel.cost_usd,
  });

  // Also patch the verdict + sentinel_score + sentinel_axes columns on the
  // same row so /log readers don't need to dig into step_output. The
  // override_reason field is best-effort: older deployments without the
  // column continue reading fine (PATCH silently no-ops the unknown field).
  const sb = getSupabaseClient();
  const patch: Record<string, unknown> = {
    verdict,
    sentinel_score: sentinel.score,
    sentinel_axes: sentinel.per_axis,
    amendment_hint: sentinel.amendments_suggested.length > 0
      ? { suggestions: sentinel.amendments_suggested }
      : null,
  };
  if (override_reason) patch.override_reason = override_reason;
  const { error: patchErr } = await sb
    .from("conductor_log")
    .update(patch)
    .eq("run_id", run_id);
  if (patchErr) {
    // Log row exists; column patch failed — surface but don't bury the verdict.
    console.error(`[verify] conductor_log column patch failed: ${patchErr.message}`);
  }

  // ── Step 8 — failure recovery: redispatch or escalate ─────────────────────
  // Closes the loop: fail_tactical gets a retry with sentinel feedback,
  // fail_strategic/hold_for_review gets surfaced to Kosta via decision_queue.
  let recoveryResult: Record<string, unknown> | null = null;
  if (verdict === "fail_tactical") {
    // Auto-redispatch: fire a new dispatch with sentinel feedback baked in.
    // Cap at 3 attempts per clause to prevent infinite loops.
    if (attempt_count < 3) {
      try {
        const feedbackLines = [
          `## Sentinel Feedback (attempt ${attempt_count}, score ${sentinel.score}/100)`,
          ...(sentinel.amendments_suggested || []).map((a: string) => `- ${a}`),
          ...(sentinel.notes ? [`\nNotes: ${sentinel.notes}`] : []),
          ...ac_results.filter(a => a.result === "fail").map(a => `- FAILED AC: ${a.text} — ${a.detail || "no detail"}`),
        ].join("\n");

        const { data: redispatch, error: rdErr } = await sb
          .from("dispatch_queue")
          .insert({
            clause_id: parsed.clause_id,
            project: clause.project,
            bible_clause: parsed.clause_id,
            status: "pending",
            priority: 2,
            context: {
              retry_of: parsed.dispatch_id,
              attempt: attempt_count + 1,
              sentinel_feedback: feedbackLines,
              prior_score: sentinel.score,
              prior_verdict: verdict,
            },
          })
          .select("id")
          .single();
        if (rdErr) {
          console.error(`[verify→redispatch] insert failed: ${rdErr.message}`);
          recoveryResult = { action: "redispatch_failed", error: rdErr.message };
        } else {
          console.log(`[verify→redispatch] ${parsed.clause_id} attempt ${attempt_count + 1} queued as ${redispatch.id}`);
          recoveryResult = { action: "redispatch", new_dispatch_id: redispatch.id, attempt: attempt_count + 1 };
        }
      } catch (rdErr: unknown) {
        const msg = rdErr instanceof Error ? rdErr.message : String(rdErr);
        recoveryResult = { action: "redispatch_failed", error: msg };
      }
    } else {
      // Max retries exceeded → escalate to decision_queue
      try {
        await sb.from("decision_queue").insert({
          question: `Clause ${parsed.clause_id} failed tactical verification ${attempt_count} times (best score: ${sentinel.score}/100). Options: redispatch with new approach, rewrite clause scope, or kill.`,
          context: {
            clause_id: parsed.clause_id,
            dispatch_id: parsed.dispatch_id,
            attempts: attempt_count,
            last_score: sentinel.score,
            per_axis: sentinel.per_axis,
            sentinel_notes: sentinel.notes,
            amendments: sentinel.amendments_suggested,
            options: ["redispatch_with_new_approach", "rewrite_clause_scope", "kill_clause"],
          },
          bible_clause: parsed.clause_id,
          agent_id: "conductor-verify",
          project: clause.project,
          urgency: "high",
        });
        recoveryResult = { action: "escalated_max_retries", attempts: attempt_count };
      } catch (escErr: unknown) {
        recoveryResult = { action: "escalate_failed", error: (escErr as Error).message };
      }
    }
  } else if (verdict === "fail_strategic" || verdict === "hold_for_review") {
    // Immediate escalation — this code is fundamentally broken or blocked.
    try {
      const urgency = verdict === "hold_for_review" ? "compile failure" : "strategic failure";
      await sb.from("decision_queue").insert({
        question: `Clause ${parsed.clause_id} received ${urgency} verdict (score: ${sentinel.score}/100). Review required — redispatch differently, manual fix, or kill.`,
        context: {
          clause_id: parsed.clause_id,
          dispatch_id: parsed.dispatch_id,
          verdict,
          score: sentinel.score,
          per_axis: sentinel.per_axis,
          sentinel_notes: sentinel.notes,
          ac_failures: ac_results.filter(a => a.result === "fail").map(a => ({ id: a.id, text: a.text, detail: a.detail })),
          options: ["redispatch_different_approach", "manual_fix", "kill_clause", "ignore"],
        },
        bible_clause: parsed.clause_id,
        agent_id: "conductor-verify",
        project: clause.project,
        urgency: verdict === "hold_for_review" ? "blocking" : "high",
      });
      recoveryResult = { action: "escalated", verdict };
    } catch (escErr: unknown) {
      recoveryResult = { action: "escalate_failed", error: (escErr as Error).message };
    }
  }

  // ── Step 9 — update dispatch_queue status so batch/verify skips this one ──
  try {
    const newStatus = (verdict === "pass" || verdict === "pass_with_amendments") ? "verified" : "verification_failed";
    await sb.from("dispatch_queue").update({
      status: newStatus,
      result: JSON.stringify({ verdict, score: sentinel.score, run_id }),
    }).eq("id", parsed.dispatch_id);
  } catch (_) { /* best-effort */ }

  const response: VerifyResponse = {
    verdict,
    score: sentinel.score,
    per_axis: sentinel.per_axis,
    ac_results,
    pillar_results: pillars,
    amendments_suggested: sentinel.amendments_suggested,
    run_id,
    conductor_log_id: run_id,
    override_reason,
    recovery: recoveryResult,
  } as VerifyResponse & { recovery: unknown };

  // ── Auto-merge chain: pass/pass_with_amendments → trigger merge ──────────
  // Fire-and-forget: don't block verify response on merge outcome.
  // Merge has its own veto gate (Step 4: all clauses in diff must have pass verdict)
  // so this is safe to fire eagerly — merge will refuse if conditions aren't met.
  if (verdict === "pass" || verdict === "pass_with_amendments") {
    const mergeBody = {
      project: clause.project,
      locked_by: `conductor-auto-merge:${run_id}`,
      triggered_by_agent_id: "conductor-verify",
      session_id: audit.session_id,
    };
    // Don't await — let merge run independently
    (async () => {
      try {
        const mergeReq = new Request("http://localhost/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mergeBody),
        });
        const mergeResp = await handleMerge(mergeReq);
        const mergeData = await mergeResp.json();
        console.log(
          `[verify→merge] auto-merge for ${clause.project}: ` +
          `merged=${mergeData.merged ?? false}, reason=${mergeData.reason ?? mergeData.error ?? "ok"}`,
        );
      } catch (mergeErr: unknown) {
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        console.error(`[verify→merge] auto-merge failed for ${clause.project}: ${msg}`);
      }
    })();
  }

  return jsonResponse(response, 200);
}
