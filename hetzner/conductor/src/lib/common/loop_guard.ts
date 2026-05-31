// supabase/functions/_common/loop_guard.ts
// AGT.1.3 — Guards against runaway agent loops.
//
// Three primary checks:
//   checkDedup(table, input_hash, seconds) — has this exact input run in the recent window?
//   checkHourlyCap(table, group_key, cap)  — has the cap on group_key been hit in the last hour?
//   heartbeat(table, run_id)               — write heartbeat_at = now (stuck-run watchdog input)
//
// Plus utility hashInput(obj) for callers to derive a stable input_hash.

import { getSupabaseClient } from "./db.js";
import type { LogTable, LoopGuardResult } from "./types.js";

/**
 * Stable SHA-256 hash of an arbitrary JSON-serializable input. Key order is
 * normalized so {a:1,b:2} and {b:2,a:1} produce the same hash.
 *
 * Use to populate the input_hash column read by checkDedup.
 */
export async function hashInput(input: unknown): Promise<string> {
  const canonical = canonicalize(input);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/**
 * Returns the run_id of a prior run in the last `seconds` window whose
 * step_input.input_hash matches, or null if none. Caller uses this to
 * short-circuit duplicate dispatches.
 *
 * The log row writer is responsible for putting `input_hash` inside step_input;
 * we look it up via the jsonb path.
 */
export async function checkDedup(
  table: LogTable,
  input_hash: string,
  seconds: number,
): Promise<string | null> {
  const sb = getSupabaseClient();
  const cutoff = new Date(Date.now() - seconds * 1000).toISOString();
  const { data, error } = await sb
    .from(table)
    .select("run_id")
    .gte("created_at", cutoff)
    .eq("step_input->>input_hash", input_hash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`loop_guard.checkDedup(${table}): ${error.message}`);
  }
  return data ? (data as { run_id: string }).run_id : null;
}

/**
 * Returns true if `group_key` has been logged on `table` more than `cap` times
 * in the last hour. The group_key is matched against step_input->>group_key.
 *
 * Conductor uses this to detect runaway retries per-clause; Scoper uses this
 * to detect repeated plan() calls for the same feature.
 */
export async function checkHourlyCap(
  table: LogTable,
  group_key: string,
  cap: number,
): Promise<boolean> {
  const sb = getSupabaseClient();
  const cutoff = new Date(Date.now() - 3600 * 1000).toISOString();
  const { count, error } = await sb
    .from(table)
    .select("run_id", { count: "exact", head: true })
    .gte("created_at", cutoff)
    .eq("step_input->>group_key", group_key);
  if (error) {
    throw new Error(`loop_guard.checkHourlyCap(${table}): ${error.message}`);
  }
  return (count ?? 0) >= cap;
}

/**
 * Update heartbeat_at on an existing log row. Loop_guard's stuck-run watchdog
 * (separate cron, AGT.1.x.x) reads this column to detect dead runs.
 */
export async function heartbeat(table: LogTable, run_id: string): Promise<void> {
  const sb = getSupabaseClient();
  const { error } = await sb
    .from(table)
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("run_id", run_id);
  if (error) {
    throw new Error(`loop_guard.heartbeat(${table}, ${run_id}): ${error.message}`);
  }
}

/**
 * Combined guard: run dedup + hourly-cap checks in one call, returning a
 * structured verdict. Useful at the top of every conductor/scoper handler.
 */
export interface RunGuardsInput {
  table: LogTable;
  input_hash: string;
  group_key: string;
  dedup_window_seconds: number;
  hourly_cap: number;
}

export async function runGuards(input: RunGuardsInput): Promise<LoopGuardResult> {
  const [prior, capHit] = await Promise.all([
    checkDedup(input.table, input.input_hash, input.dedup_window_seconds),
    checkHourlyCap(input.table, input.group_key, input.hourly_cap),
  ]);
  if (prior) {
    return { ok: false, reason: "dedup_collision", prior_run_id: prior };
  }
  if (capHit) {
    return { ok: false, reason: "hourly_cap_exceeded", retry_after_ms: 3600 * 1000 };
  }
  return { ok: true };
}
