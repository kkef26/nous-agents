// supabase/functions/conductor/treeExecutorGuard.ts
// NOUS.FGCONTRACT.5 — Spawn-time guard orchestrator.
//
// The tree executor calls guardClauseSpawn(clause, deps) immediately before
// every worker spawn. The orchestrator:
//
//   1. Reads requires[] status live from bible_clauses (checkRequiresSatisfied).
//   2. If satisfied → returns spawn_authorized=true; caller fires the worker.
//   3. If not satisfied → writes a held row on wave_queue and returns
//      spawn_authorized=false. Caller skips the spawn entirely.
//
// The worker is NEVER allowed to perform its own dependency check as a
// substitute for this executor-level gate (constraint). The check runs
// before any spawn call, every time, for every clause whose requires[] is
// non-empty.

import {
  checkRequiresSatisfied,
  type CheckRequiresResult,
  type RequiresStatusReader,
} from "./requiresGuard.ts";
import {
  holdClauseForRequires,
  type WaveQueueDb,
} from "./waveQueue.ts";

export interface GuardSpawnInput {
  clause_id: string;
  // The clause's recorded requires[] array, from bible_clauses or the
  // dispatch tree plan. The executor passes the live array — there is no
  // caching layer between bible_clauses and this function.
  requires: string[] | null | undefined;
  project: string;
  feature_id?: string | null;
  tree_run_id?: string | null;
  reported_by: string;
}

export interface GuardSpawnDeps {
  statusReader: RequiresStatusReader;
  waveQueue: WaveQueueDb;
}

export interface GuardSpawnResult {
  spawn_authorized: boolean;
  // The full check result, regardless of authorization. Useful for logging.
  check: CheckRequiresResult;
  // If spawn_authorized=false, this records whether the wave_queue hold was
  // successfully written. The caller can decide whether to retry the hold
  // (rare) or move on. spawn_authorized=true ⇒ hold_written=false (no hold
  // was needed).
  hold_written: boolean;
  // Surface upstream errors verbatim so callers can log them.
  hold_error?: string;
}

export async function guardClauseSpawn(
  input: GuardSpawnInput,
  deps: GuardSpawnDeps,
): Promise<GuardSpawnResult> {
  if (!input.clause_id) {
    throw new Error("guardClauseSpawn: clause_id required");
  }
  if (!input.project) {
    throw new Error("guardClauseSpawn: project required");
  }
  if (!input.reported_by) {
    throw new Error("guardClauseSpawn: reported_by required");
  }
  // Step 1: live check. Throws are caller's problem — they signal a wiring
  // bug (bad DB client). The check itself wraps query errors into a
  // satisfied=false verdict with a query_failed reason.
  const check = await checkRequiresSatisfied(deps.statusReader, {
    clause_id: input.clause_id,
    requires: input.requires,
  });

  if (check.satisfied) {
    return {
      spawn_authorized: true,
      check,
      hold_written: false,
    };
  }

  // Step 2: hold the clause. Spawn is NOT authorised.
  const hold = await holdClauseForRequires(deps.waveQueue, {
    clause_id: input.clause_id,
    project: input.project,
    feature_id: input.feature_id,
    tree_run_id: input.tree_run_id,
    check,
    reported_by: input.reported_by,
  });

  return {
    spawn_authorized: false,
    check,
    hold_written: hold.ok,
    hold_error: hold.error,
  };
}
