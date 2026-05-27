// supabase/functions/scoper/_shared.ts
// AGT.1.2 — Local helpers used by plan/replan/prerequisites/decomposition/waves.
// Kept here (not in _common/) because they encode Scoper-specific shapes.

import { getSupabaseClient } from "../common/db.ts";

export const SCOPER_VERSION = "scoper-v0.1.0";
export const DEDUP_WINDOW_SECONDS = 30;
export const HOURLY_PLAN_CAP = 5;
export const HARD_TIMEOUT_MS = 90_000;
export const JSON_HEADERS = { "Content-Type": "application/json" };

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface DispatchTreeRow {
  feature_id: string;
  project: string;
  scoper_run_id: string | null;
  prior_plan_id?: string | null;
  clauses: unknown;          // jsonb array of clause specs
  waves: unknown;            // jsonb array of wave specs
  customer_experience: string | null;
  preconditions: unknown;    // jsonb array of strings
  outcome_mode: "A" | "B" | "C";
  delta_from_prior?: unknown;
}

/**
 * Insert a row into nous.dispatch_tree if the table exists; otherwise log
 * and return null. Mode A emission must not crash on a missing table during
 * the bootstrap window (table is created by a sibling migration clause).
 */
export async function insertDispatchTree(row: DispatchTreeRow): Promise<string | null> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("dispatch_tree")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    const msg = (error.message ?? "").toLowerCase();
    if (msg.includes("does not exist") || msg.includes("not found") || msg.includes("relation")) {
      console.warn(`[scoper] dispatch_tree table missing — row not persisted (feature=${row.feature_id})`);
      return null;
    }
    throw new Error(`scoper.insertDispatchTree: ${error.message}`);
  }
  return data ? (data as { id: string }).id : null;
}

/**
 * Emit a Scoper signal via nous.agent_events (same channel conductor uses
 * for `shipped`). Names per persona spec: scoper_plan_emitted, scoper_held,
 * scoper_escalate, scoper_replan_requested, dedup_skip, loop_halt.
 */
export async function emitScoperSignal(
  event_type: string,
  project: string,
  agent_id: string,
  session_id: string,
  summary: string,
  details: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { error } = await (sb as any).from("agent_events").insert({
    event_type,
    agent_id,
    agent_type: "scoper",
    project,
    summary,
    details,
    session_id,
  });
  if (error) {
    console.error(`[scoper] emitScoperSignal(${event_type}): ${error.message}`);
  }
}

/**
 * Write features.scoper_findings (jsonb) for Mode B. Also stamps
 * scoper_last_run_at and scoper_last_mode.
 */
export async function writeScoperFindings(
  feature_id: string,
  findings: Record<string, unknown> | null,
  mode: "plan" | "replan",
): Promise<void> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { error } = await (sb as any)
    .from("features")
    .update({
      scoper_findings: findings,
      scoper_last_run_at: new Date().toISOString(),
      scoper_last_mode: mode,
    })
    .eq("id", feature_id);
  if (error) {
    throw new Error(`scoper.writeScoperFindings(${feature_id}): ${error.message}`);
  }
}

/**
 * Insert a row into nous.decision_queue for Mode C structural escalation.
 */
export async function insertDecisionQueue(
  project: string,
  bible_clause: string,
  question: string,
  context: Record<string, unknown>,
): Promise<string | null> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("decision_queue")
    .insert({
      project,
      bible_clause,
      question,
      context,
      urgency: "blocking",
      status: "pending",
      agent_id: "scoper",
    })
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`scoper.insertDecisionQueue: ${error.message}`);
  }
  return data ? (data as { id: string }).id : null;
}
