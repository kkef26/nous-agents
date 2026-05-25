// supabase/functions/scoper/waves.ts
// AGT.1.2 — Wave organization: feature_group + DAG + WSJF priority ranking
// + sequence_order assignment.
//
// WSJF = cost_of_delay / expected_effort.  Critical-path clauses always
// override WSJF (they ship first regardless of their score). All fields
// here are schema-conformant with bible_clauses (feature_id, sequence_order,
// requires, enables, critical_path).

import type { ClauseSpec } from "./decomposition.ts";

export interface Wave {
  index: number;                 // 0-based wave number
  clause_ids: string[];          // clauses in this wave (parallel_safe with each other)
  rationale: string;             // human-readable reason
}

export interface WaveOrganization {
  feature_group: string;
  waves: Wave[];
  clauses: ClauseSpec[];         // re-emitted with sequence_order + parallel_safe_with stamped
  total_clauses: number;
  critical_path_clauses: string[];
}

// ─── WSJF ────────────────────────────────────────────────────────────────────

function estimateEffort(c: ClauseSpec): number {
  // Heuristic: body length is the best signal we have at SCAFFOLD stage.
  // Map 0-2K = 1, 2-5K = 3, 5-10K = 5, 10K+ = 8.
  const len = c.body.length;
  if (len < 2000) return 1;
  if (len < 5000) return 3;
  if (len < 10_000) return 5;
  return 8;
}

function estimateCostOfDelay(c: ClauseSpec): number {
  // Critical-path bumps cost-of-delay. # of `enables` is a downstream-impact
  // proxy: blocking N successors costs N units of delay. Add 5 if critical_path.
  const downstream = c.enables.length;
  return downstream + (c.critical_path ? 5 : 0) + 1; // +1 so denom>0 even for leaves
}

function wsjfScore(c: ClauseSpec): number {
  return estimateCostOfDelay(c) / estimateEffort(c);
}

// ─── DAG-based wave layering (Kahn's algorithm) ──────────────────────────────

function layerByDAG(clauses: ClauseSpec[]): Wave[] {
  const byId = new Map(clauses.map((c) => [c.id, c]));
  const remaining = new Set(clauses.map((c) => c.id));
  const inDegree = new Map<string, number>();
  for (const c of clauses) {
    // Only count requires that are inside this feature; external deps don't gate waves here.
    const internalReqs = c.requires.filter((r) => byId.has(r));
    inDegree.set(c.id, internalReqs.length);
  }

  const waves: Wave[] = [];
  let waveIdx = 0;
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);
    if (ready.length === 0) {
      // Cycle or unsatisfied external deps — drop remaining into a final
      // "blocked" wave so they're still represented.
      waves.push({
        index: waveIdx,
        clause_ids: [...remaining],
        rationale: "fallback: cycle or external dependency — review requires field",
      });
      break;
    }
    // Within a ready set, sort by WSJF descending, critical_path first.
    ready.sort((a, b) => {
      const ca = byId.get(a)!;
      const cb = byId.get(b)!;
      if (ca.critical_path !== cb.critical_path) return ca.critical_path ? -1 : 1;
      const wa = wsjfScore(ca);
      const wb = wsjfScore(cb);
      if (wa !== wb) return wb - wa;
      return a.localeCompare(b);
    });
    waves.push({
      index: waveIdx,
      clause_ids: ready,
      rationale: `${ready.length} clause(s) with all internal requires already in earlier waves`,
    });
    // Remove ready set and decrement in-degree of dependents
    for (const id of ready) {
      remaining.delete(id);
      for (const c of clauses) {
        if (c.requires.includes(id)) {
          inDegree.set(c.id, (inDegree.get(c.id) ?? 1) - 1);
        }
      }
    }
    waveIdx += 1;
  }
  return waves;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function organizeWaves(featureId: string, clauses: ClauseSpec[]): WaveOrganization {
  if (clauses.length === 0) {
    return {
      feature_group: featureId,
      waves: [],
      clauses: [],
      total_clauses: 0,
      critical_path_clauses: [],
    };
  }

  const waves = layerByDAG(clauses);

  // Stamp sequence_order (1-based, monotonic across waves) and
  // parallel_safe_with (sibling clause_ids in the same wave) onto each clause.
  // priority_rank is a per-feature 1-based rank across all clauses, WSJF-sorted.
  const wsjfRanked = [...clauses].sort((a, b) => {
    if (a.critical_path !== b.critical_path) return a.critical_path ? -1 : 1;
    return wsjfScore(b) - wsjfScore(a);
  });
  const priorityByClause = new Map<string, number>();
  wsjfRanked.forEach((c, i) => priorityByClause.set(c.id, i + 1));

  const stamped: ClauseSpec[] = [];
  let seq = 0;
  for (const wave of waves) {
    for (const cid of wave.clause_ids) {
      const c = clauses.find((x) => x.id === cid);
      if (!c) continue;
      seq += 1;
      stamped.push({
        ...c,
        feature_group: featureId,
        sequence_order: seq,
        parallel_safe_with: wave.clause_ids.filter((x) => x !== c.id),
      });
    }
  }

  const critical_path_clauses = stamped.filter((c) => c.critical_path).map((c) => c.id);

  return {
    feature_group: featureId,
    waves,
    clauses: stamped,
    total_clauses: stamped.length,
    critical_path_clauses,
  };
}

/** Public for tests: expose WSJF computation. */
export function _wsjfForClause(c: ClauseSpec): number {
  return wsjfScore(c);
}
