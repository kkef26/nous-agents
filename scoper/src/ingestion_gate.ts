// NOUS.IDLOCK.6 — Ingestion → graph/read wave gate.
//
// Pure function. Reads clause_type set by enrichment, treats every
// `ingestion`-typed clause as a hard prerequisite for every `graph`- or
// `read`-typed clause within the same feature, and writes the union into
// each dependent clause's requires[]. layerByDAG (waves.ts) then naturally
// stages ingestion clauses in an earlier wave because dependents now carry
// the correct in-degree.
//
// Invariants (matches NOUS.IDLOCK.6 ACs):
//   - never mutates input clauses
//   - never crosses feature boundaries
//   - deduplicates requires[] entries
//   - idempotent (re-running the gate produces the same requires[] set)
//   - never invents clause_type — consumes the value already set upstream

import type { ClauseSpec } from "./decomposition.js";

const INGESTION_TYPES: ReadonlySet<string> = new Set(["ingestion"]);
const DEPENDENT_TYPES: ReadonlySet<string> = new Set(["graph", "read"]);

type Role = "ingestion" | "dependent" | "other";

function classify(clauseType: string | null | undefined): Role {
  if (!clauseType || typeof clauseType !== "string") return "other";
  const t = clauseType.toLowerCase();
  if (INGESTION_TYPES.has(t)) return "ingestion";
  if (DEPENDENT_TYPES.has(t)) return "dependent";
  return "other";
}

/**
 * Inject ingestion clauses as hard requires for graph/read clauses within the
 * same feature. Returns a new array. Unmodified clauses share the original
 * object reference; every modified clause is a fresh object so callers can
 * detect changes via reference inequality (AC #5).
 */
export function injectIngestionGates(clauses: readonly ClauseSpec[]): ClauseSpec[] {
  if (!Array.isArray(clauses) || clauses.length === 0) {
    return [...(clauses ?? [])];
  }

  const ingestionByFeature = new Map<string, string[]>();
  for (const c of clauses) {
    if (classify(c.clause_type) !== "ingestion") continue;
    const fid = c.feature_id;
    if (!fid) continue;
    let bucket = ingestionByFeature.get(fid);
    if (!bucket) {
      bucket = [];
      ingestionByFeature.set(fid, bucket);
    }
    bucket.push(c.id);
  }

  // No ingestion clauses → return a shallow copy so callers always get a fresh
  // array but element references are preserved (AC #2: no requires[]
  // modification anywhere).
  if (ingestionByFeature.size === 0) {
    return [...clauses];
  }

  return clauses.map((c) => {
    if (classify(c.clause_type) !== "dependent") return c;
    const siblings = ingestionByFeature.get(c.feature_id);
    if (!siblings || siblings.length === 0) return c;

    const existing = Array.isArray(c.requires) ? c.requires : [];
    // Set-based dedup preserves first-seen order: existing entries first, then
    // any ingestion IDs not already present.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const id of existing) {
      if (id === c.id) continue;       // never self-require
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    let added = 0;
    for (const id of siblings) {
      if (id === c.id) continue;       // a graph clause is never its own ingestion gate
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
      added += 1;
    }

    // Always emit a fresh object for dependent clauses that had at least one
    // sibling ingestion clause in scope, even if zero new IDs were added. This
    // satisfies AC #5's "modified clause" contract (a dependent clause IS in
    // scope of the gate, whether or not the requires[] set changed) while
    // keeping idempotency: requires[] content is identical on re-run.
    void added;
    return { ...c, requires: merged };
  });
}
