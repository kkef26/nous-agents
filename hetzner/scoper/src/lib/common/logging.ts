// supabase/functions/_common/logging.ts
// AGT.1.3 — writeStep() for nous.conductor_log and nous.scoper_log.
// Auto-fills heartbeat_at + created_at if absent so callers don't need to
// import any timestamp utility.

import { getSupabaseClient } from "./db.js";
import type {
  ConductorLogRow,
  LogRow,
  LogTable,
  ScoperLogRow,
} from "./types.js";

/**
 * Insert a row into nous.scoper_log or nous.conductor_log.
 *
 * Returns the inserted run_id. Throws on DB error so callers never silently
 * lose audit trail.
 */
export async function writeStep(table: LogTable, row: LogRow): Promise<string> {
  const sb = getSupabaseClient();
  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = { ...row };
  if (!payload.heartbeat_at) payload.heartbeat_at = nowIso;
  // created_at has a DB default; only set if caller passed one explicitly.

  const { data, error } = await sb
    .from(table)
    .insert(payload)
    .select("run_id")
    .single();

  if (error) {
    throw new Error(`logging.writeStep(${table}): ${error.message}`);
  }
  if (!data) {
    throw new Error(`logging.writeStep(${table}): insert returned no row`);
  }
  return (data as { run_id: string }).run_id;
}

/**
 * Convenience: write a scoper_log row with table inferred.
 */
export function writeScoperStep(row: ScoperLogRow): Promise<string> {
  return writeStep("scoper_log", row);
}

/**
 * Convenience: write a conductor_log row with table inferred.
 */
export function writeConductorStep(row: ConductorLogRow): Promise<string> {
  return writeStep("conductor_log", row);
}

/**
 * Update an existing log row's heartbeat_at to now. Used by long-running
 * steps to signal liveness; loop_guard's stuck-run watchdog reads this column.
 */
export async function bumpHeartbeat(table: LogTable, run_id: string): Promise<void> {
  const sb = getSupabaseClient();
  const { error } = await sb
    .from(table)
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("run_id", run_id);
  if (error) {
    throw new Error(`logging.bumpHeartbeat(${table}, ${run_id}): ${error.message}`);
  }
}

/**
 * Finalize a log row with terminal fields (duration_ms, error, step_output).
 * Use at the end of a step to capture timing + result without inserting a
 * second row.
 */
export interface FinalizeFields {
  step_output?: Record<string, unknown>;
  duration_ms?: number;
  error?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  actual_cost_usd?: number;
}

export async function finalizeStep(
  table: LogTable,
  run_id: string,
  fields: FinalizeFields,
): Promise<void> {
  const sb = getSupabaseClient();
  const payload: Record<string, unknown> = {
    ...fields,
    heartbeat_at: new Date().toISOString(),
  };
  const { error } = await sb.from(table).update(payload).eq("run_id", run_id);
  if (error) {
    throw new Error(`logging.finalizeStep(${table}, ${run_id}): ${error.message}`);
  }
}
