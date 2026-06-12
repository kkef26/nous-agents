// NOUS.FGCONTRACT.1 — tests for fg_dispatch_accept.ts
//
// Verifies the queue-row-per-clause contract: N-clause groups produce N-1
// sibling rows (the lead is created upstream), siblings share worker_id +
// agent_id but carry distinct clause_id values, and status transitions are
// independent (the bulk insert does not auto-couple them).
//
// Run: npx tsx --test supabase/functions/conductor/fg_dispatch_accept.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSiblingRows,
  insertManyClauseRows,
  type SiblingRow,
  type WorkerCtx,
} from "./fg_dispatch_accept.ts";

function ctx(over: Partial<WorkerCtx> = {}): WorkerCtx {
  return {
    worker_id: "c2-worker-1",
    agent_id: "c2-fg-group-1",
    project: "nous-edge",
    feature_id: "feat-uuid",
    tree_run_id: "tree-uuid",
    fleet_target: "claude2",
    priority: 5,
    model: "sonnet",
    tier: "mid",
    brain_tag: null,
    persona: null,
    triage_id: "triage-uuid",
    spawner_instance: "spawner-a",
    dispatch_branch: "dispatch/FOO.GROUP.1",
    base_sha: "abc123",
    lead_dispatch_id: "lead-uuid",
    lead_clause_id: "FOO.GROUP.1",
    context: { feature_group: true, clause_count: 4 },
    ...over,
  };
}

test("buildSiblingRows: N-clause group produces N-1 sibling rows", () => {
  const rows = buildSiblingRows(ctx(), [
    "FOO.GROUP.1",
    "FOO.GROUP.2",
    "FOO.GROUP.3",
    "FOO.GROUP.4",
  ]);
  // Lead (.1) is omitted; the other 3 become sibling rows.
  assert.equal(rows.length, 3, "expected 3 sibling rows");
  assert.deepEqual(
    rows.map((r) => r.clause_id),
    ["FOO.GROUP.2", "FOO.GROUP.3", "FOO.GROUP.4"],
    "sibling order must mirror input clauseIds",
  );
});

test("buildSiblingRows: every sibling shares worker_id + agent_id", () => {
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.3"]);
  for (const r of rows) {
    assert.equal(r.worker_id, "c2-worker-1", `worker_id mismatch on ${r.clause_id}`);
    assert.equal(r.agent_id, "c2-fg-group-1", `agent_id mismatch on ${r.clause_id}`);
  }
});

test("buildSiblingRows: sibling rows are NOT claimable as workers", () => {
  // The spawner claim filter is status='pending' AND readiness_verdict='ready'.
  // Siblings must miss BOTH filters so a second worker is never spawned for
  // a clause that's already covered by the lead worker.
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1", "FOO.GROUP.2"]);
  for (const r of rows) {
    assert.equal(r.status, "blocked", `sibling ${r.clause_id} status leaks claimable`);
    assert.equal(
      r.readiness_verdict,
      "unassessed",
      `sibling ${r.clause_id} readiness leaks claimable`,
    );
  }
});

test("buildSiblingRows: lead clause is never duplicated as a sibling", () => {
  const rows = buildSiblingRows(
    ctx({ lead_clause_id: "FOO.GROUP.1" }),
    ["FOO.GROUP.1", "FOO.GROUP.2"],
  );
  assert.equal(rows.length, 1, "expected 1 sibling");
  assert.equal(rows[0].clause_id, "FOO.GROUP.2", "only non-lead siblings emitted");
});

test("buildSiblingRows: duplicate clause_ids dedupe to a single row", () => {
  const rows = buildSiblingRows(
    ctx(),
    ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.2", "FOO.GROUP.3"],
  );
  assert.equal(rows.length, 2, "expected 2 unique siblings");
  assert.deepEqual(
    rows.map((r) => r.clause_id),
    ["FOO.GROUP.2", "FOO.GROUP.3"],
    "dedupe must preserve input order of first occurrence",
  );
});

test("buildSiblingRows: every sibling carries a distinct clause_id but shared metadata", () => {
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.3"]);
  // clause_id distinctness
  const clauseSet = new Set(rows.map((r) => r.clause_id));
  assert.equal(clauseSet.size, rows.length, "sibling clause_ids must be distinct");
  // Shared metadata
  for (const r of rows) {
    assert.equal(r.feature_id, "feat-uuid", "feature_id should propagate");
    assert.equal(r.tree_run_id, "tree-uuid", "tree_run_id should propagate");
    assert.equal(
      r.dispatch_branch,
      "dispatch/FOO.GROUP.1",
      "dispatch_branch should propagate",
    );
    assert.equal(r.base_sha, "abc123", "base_sha should propagate");
    assert.equal(r.spawner_instance, "spawner-a", "spawner_instance should propagate");
    assert.equal(r.bible_clause, r.clause_id, "bible_clause mirrors clause_id");
  }
});

test("buildSiblingRows: context records lead dispatch + clause for correlation", () => {
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1", "FOO.GROUP.2"]);
  assert.equal(rows.length, 1, "expected 1 sibling");
  const ctxOut = rows[0].context as Record<string, unknown>;
  assert.equal(ctxOut.group_sibling, true, "context.group_sibling must be true");
  assert.equal(
    ctxOut.lead_dispatch_id,
    "lead-uuid",
    "context.lead_dispatch_id must point at the lead row",
  );
  assert.equal(
    ctxOut.lead_clause_id,
    "FOO.GROUP.1",
    "context.lead_clause_id must point at the lead clause",
  );
  // Original feature_group flag from caller preserved
  assert.equal(ctxOut.feature_group, true, "caller context must be preserved");
});

test("buildSiblingRows: rows can transition status independently", () => {
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.3"]);
  // Mutate row 0's status; row 1 must NOT change. This guards against the
  // bug where rows share a single object reference and a downstream caller
  // updating one accidentally updates all.
  const before = rows[1].status;
  rows[0].status = "complete";
  assert.equal(rows[1].status, before, "sibling rows must be independent objects");
});

test("buildSiblingRows: empty clauseIds returns empty array", () => {
  const rows = buildSiblingRows(ctx(), []);
  assert.equal(rows.length, 0, "empty input must produce zero siblings");
});

test("buildSiblingRows: single-clause group (lead only) produces zero siblings", () => {
  const rows = buildSiblingRows(ctx(), ["FOO.GROUP.1"]);
  assert.equal(rows.length, 0, "single-clause group must produce zero siblings");
});

test("buildSiblingRows: missing ctx fields throw at row build time", () => {
  assert.throws(
    () => buildSiblingRows(ctx({ agent_id: "" }), ["A", "B"]),
    /agent_id required/,
    "missing agent_id must throw",
  );
});

// ─── insertManyClauseRows — mock-DB tests ───────────────────────────────────

interface MockCall {
  table: string;
  op: string;
  arg?: unknown;
}

function makeDb(opts: {
  existingClauseIds?: string[];
  insertError?: { message: string } | null;
  insertedReturnIds?: string[];
} = {}) {
  const calls: MockCall[] = [];
  const existing = opts.existingClauseIds ?? [];
  const insertedReturn = opts.insertedReturnIds;
  const insertError = opts.insertError ?? null;
  let lastInserted: SiblingRow[] = [];
  const db = {
    from(table: string) {
      calls.push({ table, op: "from" });
      return {
        select(cols: string) {
          calls.push({ table, op: "select", arg: cols });
          const chain: {
            eq: (col: string, val: unknown) => typeof chain;
            in: (
              col: string,
              vals: unknown[],
            ) => Promise<{ data: { clause_id: string }[]; error: null }>;
          } = {
            eq(_col: string, _val: unknown) {
              return chain;
            },
            in(_col: string, _vals: unknown[]) {
              return Promise.resolve({
                data: existing.map((cid) => ({ clause_id: cid })),
                error: null,
              });
            },
          };
          return chain;
        },
        insert(rows: SiblingRow[]) {
          calls.push({ table, op: "insert", arg: rows });
          lastInserted = rows;
          return {
            select(_cols: string) {
              return Promise.resolve({
                data: insertError
                  ? null
                  : (insertedReturn ?? rows.map((r) => ({ id: r.clause_id }))),
                error: insertError,
              });
            },
          };
        },
      };
    },
  };
  return { db, calls, getLastInserted: () => lastInserted };
}

test("insertManyClauseRows: bulk insert is one SQL statement", async () => {
  const { db, calls } = makeDb();
  await insertManyClauseRows(db, ctx(), ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.3"]);
  const insertCalls = calls.filter((c) => c.op === "insert");
  assert.equal(insertCalls.length, 1, "expected exactly one insert call");
  const rows = insertCalls[0].arg as SiblingRow[];
  assert.equal(rows.length, 2, "expected 2 sibling rows in single insert");
});

test("insertManyClauseRows: idempotent re-dispatch skips existing siblings", async () => {
  const { db, calls } = makeDb({ existingClauseIds: ["FOO.GROUP.2"] });
  const res = await insertManyClauseRows(db, ctx(), [
    "FOO.GROUP.1",
    "FOO.GROUP.2", // already exists
    "FOO.GROUP.3",
  ]);
  assert.equal(res.attempted, 2, "expected 2 attempted");
  assert.equal(res.skipped_existing, 1, "expected 1 skipped");
  assert.equal(res.inserted, 1, "expected 1 inserted");
  const insertCalls = calls.filter((c) => c.op === "insert");
  const rows = insertCalls[0].arg as SiblingRow[];
  assert.equal(rows.length, 1, "only the new sibling was inserted");
  assert.equal(rows[0].clause_id, "FOO.GROUP.3", "existing clause filtered out");
});

test("insertManyClauseRows: re-dispatch with all siblings present performs zero inserts", async () => {
  const { db, calls } = makeDb({
    existingClauseIds: ["FOO.GROUP.2", "FOO.GROUP.3"],
  });
  const res = await insertManyClauseRows(db, ctx(), [
    "FOO.GROUP.1",
    "FOO.GROUP.2",
    "FOO.GROUP.3",
  ]);
  assert.equal(res.inserted, 0, "no inserts when all siblings already exist");
  assert.equal(res.skipped_existing, 2, "both existing siblings skipped");
  const insertCalls = calls.filter((c) => c.op === "insert");
  assert.equal(insertCalls.length, 0, "no insert SQL when all rows would be dups");
});

test("insertManyClauseRows: bulk insert error surfaces, not swallowed", async () => {
  const { db } = makeDb({
    insertError: { message: "duplicate key value violates unique constraint" },
  });
  await assert.rejects(
    () => insertManyClauseRows(db, ctx(), ["FOO.GROUP.1", "FOO.GROUP.2"]),
    /bulk insert failed.*duplicate/,
    "insert error must propagate to caller",
  );
});

test("insertManyClauseRows: never reads rows back to verify count", async () => {
  // The constraint: 'NEVER read back inserted rows to confirm count inside
  // the hot path; use the returning clause or affected-row count from the
  // bulk insert'. After the INSERT, the only SELECT we made is the pre-insert
  // dedup query — no post-insert verification SELECT against dispatch_queue.
  const { db, calls } = makeDb();
  await insertManyClauseRows(db, ctx(), ["FOO.GROUP.1", "FOO.GROUP.2", "FOO.GROUP.3"]);
  const insertIdx = calls.findIndex((c) => c.op === "insert");
  // The .select() chained off insert() is the returning clause; it does NOT
  // hit dispatch_queue again with a fresh `from()`. Assert no post-insert
  // `from()` call.
  const postOps = calls.slice(insertIdx + 1);
  assert.equal(
    postOps.find((c) => c.op === "from"),
    undefined,
    "forbidden post-insert table read detected",
  );
});
