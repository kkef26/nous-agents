// supabase/functions/conductor/waveQueue.ts
// NOUS.FGCONTRACT.5 — Re-enqueue helper for clauses held by the
// requires-satisfied guard.
//
// When checkRequiresSatisfied returns satisfied=false, the tree executor
// must NOT spawn a worker for that clause. Instead it calls
// holdClauseForRequires which writes a 'queued' status row on the wave
// queue with held_reason populated, so the orphan-contradiction reconciler
// can retry the spawn after dependencies have shipped.
//
// We hold the clause at status='queued' specifically — never status='failed'
// or status='error'. A held clause is healthy; it's just waiting.

import type { CheckRequiresResult } from "./requiresGuard.ts";

export interface WaveQueueDb {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => {
    // deno-lint-ignore no-explicit-any
    upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => any;
    // deno-lint-ignore no-explicit-any
    update: (patch: Record<string, unknown>) => any;
  };
}

export interface HoldClauseInput {
  clause_id: string;
  project: string;
  feature_id?: string | null;
  tree_run_id?: string | null;
  // The CheckRequiresResult from requiresGuard. Held reason and blocking_ids
  // are mirrored onto the wave queue row.
  check: CheckRequiresResult;
  // Agent id of the executor that observed the hold — surfaced for audit.
  reported_by: string;
}

export interface HoldClauseResult {
  ok: boolean;
  error?: string;
}

// Constraint guard: this helper REFUSES to hold a clause whose check is
// satisfied. The caller must only call it when satisfied=false; calling it
// on a passing check is a wiring bug and must surface, not silently noop.
function validate(input: HoldClauseInput): string | null {
  if (!input.clause_id) return "clause_id required";
  if (!input.project) return "project required";
  if (!input.check) return "check result required";
  if (input.check.satisfied) {
    return "refused: check.satisfied=true (do not hold a passing clause)";
  }
  if (input.check.blocking_ids.length === 0) {
    return "refused: blocking_ids empty (would be silent failure)";
  }
  if (!input.check.held_reason) {
    return "refused: held_reason empty (downstream cannot debug the hold)";
  }
  return null;
}

// Upsert a row on the wave queue marking the clause as held by requires[].
// Calling it twice with the same (clause_id, tree_run_id) updates the
// existing row's blocking_ids/held_reason — important for re-evaluation by
// the reconciler so the row stays current.
export async function holdClauseForRequires(
  db: WaveQueueDb,
  input: HoldClauseInput,
): Promise<HoldClauseResult> {
  const err = validate(input);
  if (err) return { ok: false, error: err };
  const nowIso = new Date().toISOString();
  const row = {
    clause_id: input.clause_id,
    project: input.project,
    feature_id: input.feature_id ?? null,
    tree_run_id: input.tree_run_id ?? null,
    status: "queued",
    held_reason: input.check.held_reason,
    blocking_ids: input.check.blocking_ids,
    observed_statuses: input.check.observed_statuses,
    reported_by: input.reported_by,
    held_at: nowIso,
    updated_at: nowIso,
  };
  // deno-lint-ignore no-explicit-any
  const res: any = await db
    .from("wave_queue")
    .upsert(row, { onConflict: "clause_id,tree_run_id" });
  if (res?.error) {
    return { ok: false, error: `wave_queue upsert failed: ${res.error.message}` };
  }
  return { ok: true };
}

// Mark a clause's wave_queue row as cleared once its requires[] have shipped
// and the executor has fired the worker. Optional — the executor can also
// rely on the reconciler to drop cleared rows on its next sweep.
export async function clearWaveQueueHold(
  db: WaveQueueDb,
  clauseId: string,
  treeRunId: string | null,
): Promise<HoldClauseResult> {
  if (!clauseId) return { ok: false, error: "clauseId required" };
  // deno-lint-ignore no-explicit-any
  const res: any = await db
    .from("wave_queue")
    .update({
      status: "cleared",
      cleared_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  if (res?.error) {
    return { ok: false, error: `wave_queue clear failed: ${res.error.message}` };
  }
  return { ok: true };
}
