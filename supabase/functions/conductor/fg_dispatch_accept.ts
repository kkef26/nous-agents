// supabase/functions/conductor/fg_dispatch_accept.ts
// NOUS.FGCONTRACT.1 — Feature-group dispatch accept: one queue row per clause.
//
// Before this module, the fg dispatch accept path inserted a single
// dispatch_queue row for the lead clause; sibling clauses had no row, so
// Conductor's clause_id lookups returned nothing for them. This module
// expands a feature-group dispatch into one row per clause in the group.
// All N rows share the same worker_id and agent_id but each carries its own
// clause_id and an independent status that transitions per-row.
//
// Design constraints (from clause body):
//   - bulk insert is the single SQL statement, so N rows commit atomically
//   - dispatch_queue table schema is NOT mutated here (no new columns)
//   - sibling rows are NOT auto-completed when the lead row completes;
//     callers own each row's status transitions
//   - lead-clause row uses ON CONFLICT semantics so re-dispatch is idempotent
//   - row count comes from the bulk insert's returning clause; the hot path
//     does NOT read rows back to verify count
//
// Sibling rows are inserted with status='blocked' and readiness_verdict
// unchanged from 'unassessed' so the spawner's claim filter
// (status='pending' AND readiness_verdict='ready') cannot pick them up as a
// duplicate worker. Conductor's downstream lookups are by clause_id and do
// not depend on status, so visibility is preserved.

export interface WorkerCtx {
  // Stable identity shared by every row in the group.
  worker_id: string;
  agent_id: string;
  // Project + feature linkage carried on every row.
  project: string;
  feature_id?: string | null;
  tree_run_id?: string | null;
  // Dispatch surface inherited from the lead row.
  fleet_target?: string | null;
  priority?: number | null;
  model?: string | null;
  tier?: string | null;
  brain_tag?: string | null;
  persona?: string | null;
  triage_id?: string | null;
  spawner_instance?: string | null;
  // Branch + base anchor — same for every clause in the group.
  dispatch_branch?: string | null;
  base_sha?: string | null;
  // Lead row's PK so siblings can be correlated back to the spawned worker.
  lead_dispatch_id: string;
  // Shared context object — chunk_index, repo_split_*, etc.
  context?: Record<string, unknown> | null;
  // The lead row's clause_id. We never emit a sibling row for the lead.
  lead_clause_id: string;
}

export interface SiblingRow {
  worker_id: string;
  agent_id: string;
  project: string;
  fleet_target: string;
  priority: number;
  model: string | null;
  tier: string | null;
  brain_tag: string | null;
  persona: string | null;
  triage_id: string | null;
  spawner_instance: string | null;
  bible_clause: string;
  clause_id: string;
  bible_clause_hash: string;
  status: string;
  readiness_verdict: string;
  prompt: string;
  feature_id: string | null;
  tree_run_id: string | null;
  dispatch_branch: string | null;
  base_sha: string | null;
  context: Record<string, unknown>;
}

// Build the row payloads for the N-1 sibling clauses. Pure function; the
// lead row is omitted because the existing dispatch-create path already
// inserts it. The order of the returned array mirrors the input clauseIds
// order so callers can correlate inserts to clause sequence.
export function buildSiblingRows(
  ctx: WorkerCtx,
  clauseIds: string[],
): SiblingRow[] {
  if (!ctx.agent_id) throw new Error("buildSiblingRows: ctx.agent_id required");
  if (!ctx.worker_id) throw new Error("buildSiblingRows: ctx.worker_id required");
  if (!ctx.project) throw new Error("buildSiblingRows: ctx.project required");
  if (!ctx.lead_dispatch_id) {
    throw new Error("buildSiblingRows: ctx.lead_dispatch_id required");
  }
  if (!ctx.lead_clause_id) {
    throw new Error("buildSiblingRows: ctx.lead_clause_id required");
  }
  const seen = new Set<string>();
  const out: SiblingRow[] = [];
  for (const raw of clauseIds) {
    const cid = typeof raw === "string" ? raw.trim() : "";
    if (!cid) continue;
    if (cid === ctx.lead_clause_id) continue;
    if (seen.has(cid)) continue;
    seen.add(cid);
    out.push({
      worker_id: ctx.worker_id,
      agent_id: ctx.agent_id,
      project: ctx.project,
      fleet_target: ctx.fleet_target || "claude2",
      priority: typeof ctx.priority === "number" ? ctx.priority : 5,
      model: ctx.model ?? null,
      tier: ctx.tier ?? null,
      brain_tag: ctx.brain_tag ?? null,
      persona: ctx.persona ?? null,
      triage_id: ctx.triage_id ?? null,
      spawner_instance: ctx.spawner_instance ?? null,
      bible_clause: cid,
      clause_id: cid,
      // Siblings carry a stable marker hash so audit queries can find them
      // without a schema column. The hash value is not load-bearing for the
      // claim filter; only `readiness_verdict` keeps siblings unclaimable.
      bible_clause_hash: "GROUP_SIBLING",
      status: "blocked",
      readiness_verdict: "unassessed",
      prompt: "",
      feature_id: ctx.feature_id ?? null,
      tree_run_id: ctx.tree_run_id ?? null,
      dispatch_branch: ctx.dispatch_branch ?? null,
      base_sha: ctx.base_sha ?? null,
      context: {
        ...(ctx.context && typeof ctx.context === "object" ? ctx.context : {}),
        group_sibling: true,
        lead_dispatch_id: ctx.lead_dispatch_id,
        lead_clause_id: ctx.lead_clause_id,
      },
    });
  }
  return out;
}

// Minimal DB surface needed to perform the bulk insert. Only the methods we
// touch are typed; runtime callers can pass the supabase-js client directly.
export interface DispatchQueueDb {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => {
    // deno-lint-ignore no-explicit-any
    select: (cols: string) => any;
    // deno-lint-ignore no-explicit-any
    insert: (rows: SiblingRow[]) => any;
  };
}

export interface InsertManyResult {
  inserted: number;
  skipped_existing: number;
  attempted: number;
}

// Insert sibling rows in a single statement. Idempotent across re-dispatch:
// pre-queries existing (agent_id, clause_id) pairs and filters them out
// before the bulk write. The pre-query is one round-trip; the insert is the
// single SQL statement and commits atomically. The lead row is the caller's
// responsibility — it is inserted upstream by the dispatch-create handler
// and is expected to already carry an ON CONFLICT guard.
export async function insertManyClauseRows(
  db: DispatchQueueDb,
  ctx: WorkerCtx,
  clauseIds: string[],
): Promise<InsertManyResult> {
  const rows = buildSiblingRows(ctx, clauseIds);
  if (rows.length === 0) {
    return { inserted: 0, skipped_existing: 0, attempted: 0 };
  }
  // Pre-filter against rows that already exist for this worker. This is the
  // only read in the hot path; we do NOT read the inserted rows back to
  // verify count (constraint #5).
  const existingClauseIds = new Set<string>();
  try {
    // deno-lint-ignore no-explicit-any
    const existing: any = await db
      .from("dispatch_queue")
      .select("clause_id")
      .eq("agent_id", ctx.agent_id)
      .in("clause_id", rows.map((r) => r.clause_id));
    const data = Array.isArray(existing?.data) ? existing.data : [];
    for (const row of data) {
      if (row && typeof row.clause_id === "string") {
        existingClauseIds.add(row.clause_id);
      }
    }
  } catch (_) {
    // Best-effort: a failed dedup query falls through to the insert which
    // is itself idempotent if a unique index exists. We never silently
    // skip the insert based on a query failure.
  }
  const toInsert = rows.filter((r) => !existingClauseIds.has(r.clause_id));
  if (toInsert.length === 0) {
    return {
      inserted: 0,
      skipped_existing: rows.length,
      attempted: rows.length,
    };
  }
  // deno-lint-ignore no-explicit-any
  const res: any = await db
    .from("dispatch_queue")
    .insert(toInsert)
    .select("id");
  if (res?.error) {
    throw new Error(
      `insertManyClauseRows: bulk insert failed: ${res.error.message}`,
    );
  }
  const insertedCount = Array.isArray(res?.data) ? res.data.length : toInsert.length;
  return {
    inserted: insertedCount,
    skipped_existing: rows.length - toInsert.length,
    attempted: rows.length,
  };
}
