// NOUS.IDLOCK.6 — Ingestion-before-graph wave gate.
//
// Pure helper: rewrites graph/read clauses so they hard-require every
// ingestion clause within the same feature batch. The dispatch tree's wave
// assignment (waves.ts:layerByDAG) consumes the updated requires[] and places
// ingestion clauses in an earlier wave structurally — there is no path for the
// pipeline to dispatch a graph or read clause before its feature's ingestion
// work has completed.
//
// AXO.26 incident: a wave plan put graph endpoints in wave 2 with no gate on
// data landing, so graph queries ran against empty tables. This gate encodes
// the ordering invariant in the structure rather than relying on clause
// authors to wire requires by hand.
//
// Constraints (per clause body):
//   - NEVER mutate input clause objects; return new objects with new requires.
//   - NEVER apply the gate across feature boundaries — caller MUST pass a
//     single-feature batch (the public callsite in waves.ts already does so).
//   - NEVER add duplicate entries to requires; deduplicate via Set.
//   - NEVER assign or infer clause_type; consume it as already-set by enrichment.
//   - NEVER suppress when ingestion is present but already requires-linked;
//     idempotency must be enforced via dedup, not by skipping the gate.

/**
 * Minimal clause shape this gate touches. Kept narrow on purpose so the gate
 * works with both ClauseSpec (decomposition output) and any reduced row shape
 * a future caller might assemble.
 */
export interface GatedClause {
  id: string;
  clause_type: string;
  requires: string[];
}

/**
 * Clause types that the gate treats as "downstream of ingestion". Anything else
 * is left alone. Matching is exact string equality — clause_type is consumed
 * as already set by enrichment (constraint #4).
 */
const DOWNSTREAM_TYPES = new Set(['graph', 'read']);

/** Clause type that the gate inserts as a hard prerequisite. */
const INGESTION_TYPE = 'ingestion';

export interface GateResult<T extends GatedClause> {
  /** New clause array with updated requires[] on graph/read clauses. */
  clauses: T[];
  /**
   * IDs of ingestion clauses found in the input. Empty when none are present
   * (in which case the function is a no-op and clauses are returned unchanged).
   */
  ingestion_ids: string[];
  /**
   * IDs of downstream clauses (graph/read) whose requires[] was actually
   * extended by this call. Excludes clauses whose requires already covered
   * every ingestion id — useful for telemetry/logging.
   */
  rewritten_ids: string[];
}

/**
 * Inject ingestion clauses as hard requires for every graph/read clause in
 * the same feature batch. Pure and idempotent: calling injectIngestionGates
 * twice on the same input produces the same output as calling it once.
 */
export function injectIngestionGates<T extends GatedClause>(clauses: T[]): GateResult<T> {
  const ingestion_ids = clauses
    .filter((c) => c.clause_type === INGESTION_TYPE)
    .map((c) => c.id);

  if (ingestion_ids.length === 0) {
    // No ingestion work in this batch — nothing to gate. Return the input
    // unchanged (still a new array reference for caller convenience).
    return { clauses: [...clauses], ingestion_ids: [], rewritten_ids: [] };
  }

  const rewritten_ids: string[] = [];
  const out: T[] = clauses.map((c) => {
    if (!DOWNSTREAM_TYPES.has(c.clause_type)) {
      // Ingestion + everything else passes through with a fresh requires[] copy
      // (no in-place mutation, even for unchanged rows).
      return { ...c, requires: [...(c.requires ?? [])] };
    }

    const existing = new Set(c.requires ?? []);
    // Don't allow a clause to require itself (would deadlock the DAG) — this
    // only matters if an ingestion clause is somehow re-typed as graph/read,
    // but defensive coding is cheap here.
    let added = false;
    for (const ingestionId of ingestion_ids) {
      if (ingestionId === c.id) continue;
      if (!existing.has(ingestionId)) {
        existing.add(ingestionId);
        added = true;
      }
    }
    if (added) rewritten_ids.push(c.id);
    return { ...c, requires: [...existing] };
  });

  return { clauses: out, ingestion_ids, rewritten_ids };
}
