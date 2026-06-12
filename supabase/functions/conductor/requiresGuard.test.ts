// NOUS.FGCONTRACT.5 — tests for requiresGuard.ts + waveQueue.ts
//
// Run: npx tsx --test supabase/functions/conductor/requiresGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRequiresSatisfied,
  SATISFYING_STATUS,
  type CheckRequiresInput,
  type RequiresStatusReader,
} from "./requiresGuard.ts";
import {
  clearWaveQueueHold,
  holdClauseForRequires,
  type WaveQueueDb,
} from "./waveQueue.ts";

// ─── DB stubs ───────────────────────────────────────────────────────────────

interface Call {
  table: string;
  op: string;
  arg?: unknown;
}

function makeStatusReader(
  rows: Array<{ id: string; status: string }> = [],
  opts: { queryError?: { message: string } } = {},
): { db: RequiresStatusReader; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      calls.push({ table, op: "from" });
      return {
        select(cols: string) {
          calls.push({ table, op: "select", arg: cols });
          const chain = {
            in(_col: string, ids: unknown[]) {
              const filtered = rows.filter((r) =>
                (ids as string[]).includes(r.id)
              );
              return Promise.resolve({
                data: opts.queryError ? null : filtered,
                error: opts.queryError ?? null,
              });
            },
          };
          return chain;
        },
      };
    },
  };
  return { db, calls };
}

// ─── checkRequiresSatisfied ────────────────────────────────────────────────

test("checkRequiresSatisfied: empty requires returns satisfied=true", async () => {
  const { db, calls } = makeStatusReader();
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: [],
  });
  assert.equal(res.satisfied, true);
  assert.deepEqual(res.blocking_ids, []);
  assert.equal(res.held_reason, "");
  // No DB read — the empty case is a fast path.
  assert.equal(calls.filter((c) => c.op === "from").length, 0);
});

test("checkRequiresSatisfied: null requires returns satisfied=true (no-op)", async () => {
  const { db } = makeStatusReader();
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: null,
  });
  assert.equal(res.satisfied, true);
});

test("checkRequiresSatisfied: all requires shipped returns satisfied=true", async () => {
  const { db, calls } = makeStatusReader([
    { id: "NOUS.FOO.1", status: "shipped" },
    { id: "NOUS.FOO.2", status: "shipped" },
  ]);
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
  });
  assert.equal(res.satisfied, true);
  assert.deepEqual(res.blocking_ids, []);
  assert.equal(res.observed_statuses["NOUS.FOO.1"], "shipped");
  // The check MUST hit the live DB even when the result is trivially
  // satisfiable — never cache or use event-sourced status.
  assert.equal(
    calls.filter((c) => c.op === "from").length,
    1,
    "exactly one live DB read",
  );
});

test("checkRequiresSatisfied: any require not shipped returns satisfied=false", async () => {
  const { db } = makeStatusReader([
    { id: "NOUS.FOO.1", status: "shipped" },
    { id: "NOUS.FOO.2", status: "build_complete" },
  ]);
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
  });
  assert.equal(res.satisfied, false);
  assert.deepEqual(res.blocking_ids, ["NOUS.FOO.2"]);
  assert.ok(res.held_reason.includes("NOUS.FOO.2=build_complete"));
});

test("checkRequiresSatisfied: terminal-looking non-shipped status (verified) still blocks", async () => {
  // Constraint: "NEVER treat status values other than shipped as satisfying
  // a requires[] entry, regardless of how terminal they appear." 'verified'
  // looks final but is not 'shipped' — the gate must hold.
  const { db } = makeStatusReader([
    { id: "NOUS.FOO.1", status: "verified" },
  ]);
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.FOO.1"],
  });
  assert.equal(res.satisfied, false);
  assert.deepEqual(res.blocking_ids, ["NOUS.FOO.1"]);
});

test("checkRequiresSatisfied: missing dependency row blocks (status=null)", async () => {
  const { db } = makeStatusReader([]); // no rows returned at all
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.MISSING.1"],
  });
  assert.equal(res.satisfied, false);
  assert.deepEqual(res.blocking_ids, ["NOUS.MISSING.1"]);
  assert.ok(res.held_reason.includes("NOUS.MISSING.1=missing"));
});

test("checkRequiresSatisfied: query error fails closed (treats as not satisfied)", async () => {
  const { db } = makeStatusReader([], {
    queryError: { message: "permission denied" },
  });
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
  });
  assert.equal(res.satisfied, false, "query error must fail closed");
  // All required ids surface as blocking.
  assert.deepEqual(res.blocking_ids.sort(), ["NOUS.FOO.1", "NOUS.FOO.2"]);
  assert.ok(res.held_reason.startsWith("requires_check_query_failed"));
});

test("checkRequiresSatisfied: shipped constant guards against accidental expansion", () => {
  assert.equal(
    SATISFYING_STATUS,
    "shipped",
    "expanding the satisfying set requires touching this constant intentionally",
  );
});

test("checkRequiresSatisfied: ignores non-string requires entries silently", async () => {
  const { db } = makeStatusReader([{ id: "NOUS.FOO.1", status: "shipped" }]);
  const res = await checkRequiresSatisfied(db, {
    clause_id: "NOUS.FOO.5",
    // Simulating bad inbound data: requires contains non-string junk.
    // deno-lint-ignore no-explicit-any
    requires: ["NOUS.FOO.1", null as any, "", 42 as any],
  });
  assert.equal(res.satisfied, true);
  assert.deepEqual(res.blocking_ids, []);
});

test("checkRequiresSatisfied: missing clause_id throws (caller bug, not a runtime fallback)", async () => {
  const { db } = makeStatusReader();
  await assert.rejects(
    () => checkRequiresSatisfied(db, { clause_id: "", requires: ["A"] } as CheckRequiresInput),
    /clause_id required/,
  );
});

// ─── holdClauseForRequires ─────────────────────────────────────────────────

interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
  opts?: { onConflict?: string };
}

function makeWaveQueueDb(opts: { upsertError?: { message: string } } = {}) {
  const upserts: UpsertCall[] = [];
  const updates: UpsertCall[] = [];
  const db: WaveQueueDb = {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, options?: { onConflict?: string }) {
          upserts.push({ table, row, opts: options });
          return Promise.resolve({
            data: opts.upsertError ? null : { id: "wq-uuid" },
            error: opts.upsertError ?? null,
          });
        },
        update(patch: Record<string, unknown>) {
          updates.push({ table, row: patch });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { db, upserts, updates };
}

test("holdClauseForRequires: writes a queued row with held_reason + blocking_ids", async () => {
  const { db, upserts } = makeWaveQueueDb();
  const res = await holdClauseForRequires(db, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    feature_id: "feat-uuid",
    tree_run_id: "tree-uuid",
    check: {
      satisfied: false,
      blocking_ids: ["NOUS.FOO.2"],
      observed_statuses: { "NOUS.FOO.2": "build_complete" },
      held_reason: "requires_not_shipped: NOUS.FOO.2=build_complete",
    },
    reported_by: "conductor",
  });
  assert.equal(res.ok, true);
  assert.equal(upserts.length, 1);
  const row = upserts[0].row;
  assert.equal(row.status, "queued", "held rows MUST use status=queued — never failed/error");
  assert.equal(row.held_reason, "requires_not_shipped: NOUS.FOO.2=build_complete");
  assert.deepEqual(row.blocking_ids, ["NOUS.FOO.2"]);
  // Upsert keyed by (clause_id, tree_run_id) for idempotent re-evaluation.
  assert.equal(upserts[0].opts?.onConflict, "clause_id,tree_run_id");
});

test("holdClauseForRequires: refuses to hold a satisfied check", async () => {
  const { db, upserts } = makeWaveQueueDb();
  const res = await holdClauseForRequires(db, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    check: {
      satisfied: true,
      blocking_ids: [],
      observed_statuses: {},
      held_reason: "",
    },
    reported_by: "conductor",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /refused.*satisfied=true/);
  assert.equal(upserts.length, 0, "no DB write when refusing");
});

test("holdClauseForRequires: refuses to hold with empty blocking_ids", async () => {
  const { db, upserts } = makeWaveQueueDb();
  const res = await holdClauseForRequires(db, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    check: {
      satisfied: false,
      blocking_ids: [],
      observed_statuses: {},
      held_reason: "some reason",
    },
    reported_by: "conductor",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /blocking_ids empty/);
  assert.equal(upserts.length, 0);
});

test("holdClauseForRequires: refuses to hold with empty held_reason", async () => {
  const { db } = makeWaveQueueDb();
  const res = await holdClauseForRequires(db, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    check: {
      satisfied: false,
      blocking_ids: ["X"],
      observed_statuses: { X: "build_complete" },
      held_reason: "",
    },
    reported_by: "conductor",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /held_reason empty/);
});

test("holdClauseForRequires: surfaces upsert errors to caller", async () => {
  const { db } = makeWaveQueueDb({ upsertError: { message: "deadlock detected" } });
  const res = await holdClauseForRequires(db, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    check: {
      satisfied: false,
      blocking_ids: ["X"],
      observed_statuses: { X: "build_complete" },
      held_reason: "requires_not_shipped: X=build_complete",
    },
    reported_by: "conductor",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /deadlock/);
});

test("clearWaveQueueHold: emits an update against wave_queue", async () => {
  const { db, updates } = makeWaveQueueDb();
  const res = await clearWaveQueueHold(db, "NOUS.FOO.5", "tree-uuid");
  assert.equal(res.ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].table, "wave_queue");
  assert.equal(updates[0].row.status, "cleared");
});

test("clearWaveQueueHold: refuses without clauseId", async () => {
  const { db, updates } = makeWaveQueueDb();
  const res = await clearWaveQueueHold(db, "", null);
  assert.equal(res.ok, false);
  assert.equal(updates.length, 0);
});

// ─── Integration: check + hold flow ────────────────────────────────────────

test("integration: failed check feeds directly into hold call", async () => {
  // Demonstrates the contract: the tree executor would call
  // checkRequiresSatisfied first; if satisfied=false, pass the same
  // CheckRequiresResult into holdClauseForRequires.
  const { db: reader } = makeStatusReader([
    { id: "NOUS.FOO.1", status: "shipped" },
    { id: "NOUS.FOO.2", status: "build_complete" },
  ]);
  const check = await checkRequiresSatisfied(reader, {
    clause_id: "NOUS.FOO.5",
    requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
  });
  assert.equal(check.satisfied, false);
  const { db: waveDb, upserts } = makeWaveQueueDb();
  const res = await holdClauseForRequires(waveDb, {
    clause_id: "NOUS.FOO.5",
    project: "nous-edge",
    feature_id: "feat-uuid",
    tree_run_id: "tree-uuid",
    check,
    reported_by: "conductor",
  });
  assert.equal(res.ok, true);
  assert.equal(upserts.length, 1);
  // The held row inherits blocking_ids and observed_statuses verbatim from
  // the check — no information loss in the handoff.
  assert.deepEqual(upserts[0].row.blocking_ids, check.blocking_ids);
  assert.deepEqual(upserts[0].row.observed_statuses, check.observed_statuses);
});
