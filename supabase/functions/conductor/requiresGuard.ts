// supabase/functions/conductor/requiresGuard.ts
// NOUS.FGCONTRACT.5 — Spawn-time requires[] enforcement.
//
// Before the tree executor fires a worker for a clause, this guard reads the
// LIVE status of every id listed in that clause's requires[] from
// nous.bible_clauses. The clause is spawnable iff every required clause
// carries status='shipped' (meaning it has cleared the physical verification
// gate from NOUS.FGCONTRACT.4). Any other status — even apparently terminal
// values like 'failed' or 'verified' — blocks the spawn.
//
// This file contains a pure function: it does no DB writes, no spawning, no
// side effects. The caller (treeExecutor) consults the verdict and either
// fires the worker or re-enqueues the clause via waveQueue.holdClauseForRequires.

export interface ClauseStatusRow {
  id: string;
  status: string;
}

// Minimal DB surface — only the read we need. Production callers pass the
// supabase-js client directly; tests pass a mock.
export interface RequiresStatusReader {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => {
    // deno-lint-ignore no-explicit-any
    select: (cols: string) => any;
  };
}

export interface CheckRequiresInput {
  clause_id: string;
  // The clause's requires[] array. Empty/null means no prerequisites and the
  // check returns satisfied immediately.
  requires: string[] | null | undefined;
}

export interface CheckRequiresResult {
  // True iff every required clause carries status='shipped'. False otherwise.
  satisfied: boolean;
  // For false results: the list of required ids that did NOT pass the check.
  // For true results: empty array. Order matches `requires` input order.
  blocking_ids: string[];
  // Per-id status, so the caller can attach reasonable detail to the
  // held_reason on the re-enqueued clause. Missing rows surface as null.
  observed_statuses: Record<string, string | null>;
  // Free-form reason string suitable for waveQueue.held_reason. Always
  // non-empty when satisfied=false; empty string when satisfied=true.
  held_reason: string;
}

// The constraint:
//   "NEVER treat status values other than shipped as satisfying a requires[]
//   entry, regardless of how terminal they appear."
// We hard-code 'shipped' as the only satisfying value here so an accidental
// future change to expand the satisfying set has to touch this one constant.
export const SATISFYING_STATUS = "shipped";

export async function checkRequiresSatisfied(
  db: RequiresStatusReader,
  input: CheckRequiresInput,
): Promise<CheckRequiresResult> {
  if (!input.clause_id) {
    throw new Error("checkRequiresSatisfied: clause_id required");
  }
  const required = Array.isArray(input.requires)
    ? input.requires.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  if (required.length === 0) {
    return {
      satisfied: true,
      blocking_ids: [],
      observed_statuses: {},
      held_reason: "",
    };
  }
  // Constraint: NEVER use in-memory, cached, or event-sourced status. Always
  // read live. Hence a fresh query against bible_clauses.
  // deno-lint-ignore no-explicit-any
  const res: any = await db
    .from("bible_clauses")
    .select("id, status")
    .in("id", required);
  if (res?.error) {
    // A query failure must NOT be treated as satisfied. Fail closed: hold the
    // clause until the next reconciler tick can re-evaluate.
    return {
      satisfied: false,
      blocking_ids: [...required],
      observed_statuses: Object.fromEntries(required.map((id) => [id, null])),
      held_reason: `requires_check_query_failed: ${res.error.message}`,
    };
  }
  const rows: ClauseStatusRow[] = Array.isArray(res?.data) ? res.data : [];
  const observed: Record<string, string | null> = {};
  for (const id of required) observed[id] = null;
  for (const row of rows) {
    if (row && typeof row.id === "string") {
      observed[row.id] = typeof row.status === "string" ? row.status : null;
    }
  }
  const blocking: string[] = [];
  for (const id of required) {
    if (observed[id] !== SATISFYING_STATUS) blocking.push(id);
  }
  if (blocking.length === 0) {
    return {
      satisfied: true,
      blocking_ids: [],
      observed_statuses: observed,
      held_reason: "",
    };
  }
  const detail = blocking
    .map((id) => `${id}=${observed[id] ?? "missing"}`)
    .join(", ");
  return {
    satisfied: false,
    blocking_ids: blocking,
    observed_statuses: observed,
    held_reason: `requires_not_shipped: ${detail}`,
  };
}
