// NOUS.FGCONTRACT.5 — tests for treeExecutorGuard.ts
//
// Run: npx tsx --test supabase/functions/conductor/treeExecutorGuard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardClauseSpawn } from "./treeExecutorGuard.ts";
import type { RequiresStatusReader } from "./requiresGuard.ts";
import type { WaveQueueDb } from "./waveQueue.ts";

function statusReader(
  rows: Array<{ id: string; status: string }>,
): RequiresStatusReader {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: unknown[]) {
              return Promise.resolve({
                data: rows.filter((r) => (ids as string[]).includes(r.id)),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

function waveQueueRecorder(): { db: WaveQueueDb; upserts: Record<string, unknown>[]; updates: Record<string, unknown>[] } {
  const upserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const db: WaveQueueDb = {
    from(_table: string) {
      return {
        upsert(row: Record<string, unknown>) {
          upserts.push(row);
          return Promise.resolve({ data: { id: "1" }, error: null });
        },
        update(row: Record<string, unknown>) {
          updates.push(row);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { db, upserts, updates };
}

test("guardClauseSpawn: empty requires ⇒ spawn_authorized=true, no hold written", async () => {
  const { db: waveDb, upserts } = waveQueueRecorder();
  const res = await guardClauseSpawn(
    {
      clause_id: "NOUS.FOO.5",
      requires: [],
      project: "nous-edge",
      reported_by: "conductor",
    },
    { statusReader: statusReader([]), waveQueue: waveDb },
  );
  assert.equal(res.spawn_authorized, true);
  assert.equal(res.hold_written, false);
  assert.equal(upserts.length, 0, "no wave_queue write for an authorized spawn");
});

test("guardClauseSpawn: all requires shipped ⇒ authorized, no hold", async () => {
  const { db: waveDb, upserts } = waveQueueRecorder();
  const res = await guardClauseSpawn(
    {
      clause_id: "NOUS.FOO.5",
      requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
      project: "nous-edge",
      reported_by: "conductor",
    },
    {
      statusReader: statusReader([
        { id: "NOUS.FOO.1", status: "shipped" },
        { id: "NOUS.FOO.2", status: "shipped" },
      ]),
      waveQueue: waveDb,
    },
  );
  assert.equal(res.spawn_authorized, true);
  assert.equal(upserts.length, 0);
});

test("guardClauseSpawn: any unsuited require ⇒ NOT authorized, hold written", async () => {
  const { db: waveDb, upserts } = waveQueueRecorder();
  const res = await guardClauseSpawn(
    {
      clause_id: "NOUS.FOO.5",
      requires: ["NOUS.FOO.1", "NOUS.FOO.2"],
      project: "nous-edge",
      feature_id: "feat-uuid",
      tree_run_id: "tree-uuid",
      reported_by: "conductor",
    },
    {
      statusReader: statusReader([
        { id: "NOUS.FOO.1", status: "shipped" },
        { id: "NOUS.FOO.2", status: "build_complete" },
      ]),
      waveQueue: waveDb,
    },
  );
  assert.equal(res.spawn_authorized, false, "spawn must NOT be authorized");
  assert.equal(res.hold_written, true, "hold MUST be written when not authorized");
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].status, "queued", "held status MUST be queued");
  assert.deepEqual(upserts[0].blocking_ids, ["NOUS.FOO.2"]);
});

test("guardClauseSpawn: query error blocks spawn (fails closed)", async () => {
  // Status reader returns an error — the check fails closed, so the guard
  // blocks the spawn and writes a hold with held_reason explaining the failure.
  const errorReader: RequiresStatusReader = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, _ids: unknown[]) {
              return Promise.resolve({
                data: null,
                error: { message: "permission denied" },
              });
            },
          };
        },
      };
    },
  };
  const { db: waveDb, upserts } = waveQueueRecorder();
  const res = await guardClauseSpawn(
    {
      clause_id: "NOUS.FOO.5",
      requires: ["NOUS.FOO.1"],
      project: "nous-edge",
      reported_by: "conductor",
    },
    { statusReader: errorReader, waveQueue: waveDb },
  );
  assert.equal(res.spawn_authorized, false, "spawn must NOT be authorized on query error");
  assert.equal(upserts.length, 1);
  assert.match(
    String(upserts[0].held_reason),
    /query_failed/,
    "held_reason should describe the failure",
  );
});

test("guardClauseSpawn: check.observed_statuses surfaces in held row", async () => {
  // The held row mirrors the check's observed_statuses so the reconciler
  // doesn't have to re-query the same data to render the hold.
  const { db: waveDb, upserts } = waveQueueRecorder();
  await guardClauseSpawn(
    {
      clause_id: "NOUS.FOO.5",
      requires: ["NOUS.FOO.1", "NOUS.FOO.2", "NOUS.FOO.3"],
      project: "nous-edge",
      reported_by: "conductor",
    },
    {
      statusReader: statusReader([
        { id: "NOUS.FOO.1", status: "shipped" },
        { id: "NOUS.FOO.2", status: "verified" },
        // NOUS.FOO.3 missing entirely
      ]),
      waveQueue: waveDb,
    },
  );
  assert.equal(upserts.length, 1);
  const observed = upserts[0].observed_statuses as Record<string, string | null>;
  assert.equal(observed["NOUS.FOO.1"], "shipped");
  assert.equal(observed["NOUS.FOO.2"], "verified");
  assert.equal(observed["NOUS.FOO.3"], null, "missing row surfaces as null");
});

test("guardClauseSpawn: missing inputs throw (caller bug, not a runtime fallback)", async () => {
  const { db: waveDb } = waveQueueRecorder();
  await assert.rejects(
    () =>
      guardClauseSpawn(
        { clause_id: "", requires: [], project: "p", reported_by: "r" },
        { statusReader: statusReader([]), waveQueue: waveDb },
      ),
    /clause_id required/,
  );
  await assert.rejects(
    () =>
      guardClauseSpawn(
        { clause_id: "X", requires: [], project: "", reported_by: "r" },
        { statusReader: statusReader([]), waveQueue: waveDb },
      ),
    /project required/,
  );
  await assert.rejects(
    () =>
      guardClauseSpawn(
        { clause_id: "X", requires: [], project: "p", reported_by: "" },
        { statusReader: statusReader([]), waveQueue: waveDb },
      ),
    /reported_by required/,
  );
});

test("guardClauseSpawn: every call performs a fresh live read (never cached)", async () => {
  // Even if the same clause is guarded twice in a row, BOTH calls must hit
  // the DB. This protects against a developer adding a memoization layer
  // that would violate the constraint.
  let calls = 0;
  const reader: RequiresStatusReader = {
    from(_t) {
      return {
        select(_c) {
          return {
            in(_col, ids: unknown[]) {
              calls += 1;
              return Promise.resolve({
                data: (ids as string[]).map((id) => ({ id, status: "shipped" })),
                error: null,
              });
            },
          };
        },
      };
    },
  };
  const { db: waveDb } = waveQueueRecorder();
  await guardClauseSpawn(
    { clause_id: "NOUS.FOO.5", requires: ["NOUS.FOO.1"], project: "p", reported_by: "r" },
    { statusReader: reader, waveQueue: waveDb },
  );
  await guardClauseSpawn(
    { clause_id: "NOUS.FOO.5", requires: ["NOUS.FOO.1"], project: "p", reported_by: "r" },
    { statusReader: reader, waveQueue: waveDb },
  );
  assert.equal(calls, 2, "each guard call must hit the live DB");
});
