// NOUS.FGCONTRACT.4 — tests for verificationGate.ts + frictions.ts
//
// Run: npx tsx --test supabase/functions/conductor/verificationGate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyClause,
  parseContractVerification,
  runPhysicalVerificationGate,
  type ClauseToVerify,
  type GateDependencies,
  type GitReachabilityClient,
  type SqlExecutor,
  type VerificationProbe,
} from "./verificationGate.ts";
import { insertPhysicalGateFriction } from "./frictions.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function sqlOk(rows: unknown[] = [{ x: 1 }]): SqlExecutor {
  return {
    async execute(_sql: string) {
      return { rows };
    },
  };
}

function sqlError(error: string): SqlExecutor {
  return {
    async execute(_sql: string) {
      return { rows: [], error };
    },
  };
}

function sqlThrow(message: string): SqlExecutor {
  return {
    async execute(_sql: string): Promise<{ rows: unknown[]; error?: string }> {
      throw new Error(message);
    },
  };
}

function gitReachable(): GitReachabilityClient {
  return {
    async isReachableFromMain(_repo: string, _sha: string) {
      return {
        reachable: true,
        main_head: "deadbeefdeadbeefdeadbeef",
        ahead_by: 0,
        behind_by: 3,
      };
    },
  };
}

function gitUnreachable(): GitReachabilityClient {
  return {
    async isReachableFromMain(_repo: string, _sha: string) {
      return {
        reachable: false,
        main_head: "deadbeefdeadbeefdeadbeef",
        ahead_by: 12,
        behind_by: 0,
      };
    },
  };
}

function gitError(error: string): GitReachabilityClient {
  return {
    async isReachableFromMain(_repo: string, _sha: string) {
      return { reachable: false, main_head: null, error };
    },
  };
}

function gitThrow(message: string): GitReachabilityClient {
  return {
    async isReachableFromMain(_repo: string, _sha: string): Promise<{
      reachable: boolean;
      main_head: string | null;
    }> {
      throw new Error(message);
    },
  };
}

function migrationClause(over: Partial<ClauseToVerify> = {}): ClauseToVerify {
  return {
    id: "NOUS.MIG.1",
    probes: [
      {
        method: "sql",
        target: "AC01",
        command: "SELECT to_regclass('nous.foo');",
        expect: "non-null",
      },
      {
        method: "sql",
        target: "AC02",
        command: "SELECT count(*) FROM nous.foo;",
        expect: "at least one row",
      },
    ],
    shipped_in: ["abc123"],
    target_repo: "kkef26/nous-agents",
    ...over,
  };
}

function codeClause(over: Partial<ClauseToVerify> = {}): ClauseToVerify {
  return {
    id: "NOUS.CODE.1",
    probes: [
      {
        method: "grep",
        target: "AC01",
        command: "grep -rn 'foo' src/",
        expect: "≥1 match",
      },
    ],
    shipped_in: ["deadbeef123"],
    target_repo: "kkef26/nous-agents",
    ...over,
  };
}

function deps(over: Partial<GateDependencies> = {}): GateDependencies {
  return {
    sql: over.sql ?? sqlOk(),
    git: over.git ?? gitReachable(),
  };
}

// ─── classifyClause ─────────────────────────────────────────────────────────

test("classifyClause: any SQL probe ⇒ migration", () => {
  assert.equal(
    classifyClause([
      { method: "sql", target: "AC01", command: "SELECT 1;", expect: "1" },
    ]),
    "migration",
  );
});

test("classifyClause: only grep/bash probes ⇒ code", () => {
  assert.equal(
    classifyClause([
      { method: "grep", target: "AC01", command: "grep foo", expect: "any" },
      { method: "bash", target: "AC02", command: "test -f f", expect: "0" },
    ]),
    "code",
  );
});

test("classifyClause: empty probe list ⇒ code (git reachability is the sole signal)", () => {
  assert.equal(classifyClause([]), "code");
});

// ─── parseContractVerification ──────────────────────────────────────────────

test("parseContractVerification: handles JSON-string form", () => {
  const probes = parseContractVerification(JSON.stringify([
    { method: "sql", target: "AC01", command: "SELECT 1;", expect: "1" },
  ]));
  assert.equal(probes.length, 1);
  assert.equal(probes[0].command, "SELECT 1;");
});

test("parseContractVerification: handles array form", () => {
  const probes = parseContractVerification([
    { method: "grep", target: "AC01", command: "grep foo", expect: "any" },
  ]);
  assert.equal(probes.length, 1);
});

test("parseContractVerification: filters out invalid method or missing fields", () => {
  const probes = parseContractVerification([
    { method: "magic", target: "AC01", command: "...", expect: "..." },
    { method: "sql", target: "", command: "SELECT 1;", expect: "1" },
    { method: "sql", target: "AC02", command: "", expect: "1" },
    { method: "sql", target: "AC03", command: "SELECT 1;", expect: "1" },
  ]);
  assert.equal(probes.length, 1, "only the well-formed sql probe survives");
  assert.equal(probes[0].target, "AC03");
});

test("parseContractVerification: returns [] for null/garbage input", () => {
  assert.deepEqual(parseContractVerification(null), []);
  assert.deepEqual(parseContractVerification("not json at all {"), []);
  assert.deepEqual(parseContractVerification(42), []);
});

// ─── runPhysicalVerificationGate — migration branch ─────────────────────────

test("gate: migration clause passes when every SQL probe returns rows", async () => {
  const res = await runPhysicalVerificationGate(migrationClause(), deps());
  assert.equal(res.passed, true);
  assert.equal(res.classification, "migration");
  assert.equal(res.outcomes.length, 2, "both SQL probes ran");
  assert.equal(res.friction, null, "no friction emitted on pass");
});

test("gate: migration clause fails when any positive SQL probe returns zero rows", async () => {
  const sql: SqlExecutor = {
    async execute(_sql: string) {
      return { rows: [] }; // zero rows ⇒ object missing
    },
  };
  const res = await runPhysicalVerificationGate(migrationClause(), deps({ sql }));
  assert.equal(res.passed, false);
  assert.equal(res.classification, "migration");
  assert.notEqual(res.friction, null, "friction payload emitted on fail");
  assert.equal(res.friction?.source, "physical_verification_gate");
  assert.equal(res.friction?.clause_id, "NOUS.MIG.1");
  assert.equal(res.friction?.detail.classification, "migration");
  assert.equal(res.friction?.detail.failed_probes.length, 2);
});

test("gate: migration clause SQL exception ⇒ gate fails (never silently passes)", async () => {
  const res = await runPhysicalVerificationGate(
    migrationClause(),
    deps({ sql: sqlThrow("connection terminated") }),
  );
  assert.equal(res.passed, false, "thrown errors must produce gate failure");
  assert.equal(res.classification, "migration");
  for (const o of res.outcomes) {
    assert.ok(
      o.observed.startsWith("exception:"),
      `outcome should record exception, got: ${o.observed}`,
    );
  }
  // Friction must include the exception text so reconciler can debug it.
  assert.ok(res.friction);
  for (const fp of res.friction.detail.failed_probes) {
    assert.ok(fp.observed.includes("connection terminated"));
  }
});

test("gate: migration clause SQL error result ⇒ gate fails", async () => {
  const res = await runPhysicalVerificationGate(
    migrationClause(),
    deps({ sql: sqlError("relation does not exist") }),
  );
  assert.equal(res.passed, false);
  for (const o of res.outcomes) {
    assert.ok(o.observed.startsWith("error:"));
  }
});

test("gate: negative SQL probe (expect=ERROR) passes when SQL errors", async () => {
  const clause = migrationClause({
    probes: [
      {
        method: "sql",
        target: "AC01",
        command: "INSERT duplicate ...",
        expect: "ERROR: duplicate key value violates unique constraint",
      },
    ],
  });
  const res = await runPhysicalVerificationGate(
    clause,
    deps({ sql: sqlError("duplicate key value violates unique constraint") }),
  );
  assert.equal(res.passed, true, "negative probe passes when SQL errors");
});

test("gate: negative SQL probe fails when SQL unexpectedly succeeds", async () => {
  const clause = migrationClause({
    probes: [
      {
        method: "sql",
        target: "AC01",
        command: "INSERT duplicate ...",
        expect: "ERROR: should have been rejected",
      },
    ],
  });
  // sqlOk returns rows successfully — for a negative probe, that's a fail.
  const res = await runPhysicalVerificationGate(clause, deps({ sql: sqlOk() }));
  assert.equal(res.passed, false);
});

// ─── runPhysicalVerificationGate — code branch ──────────────────────────────

test("gate: code clause passes when shipped_in[0] is reachable from main", async () => {
  const res = await runPhysicalVerificationGate(codeClause(), deps());
  assert.equal(res.passed, true);
  assert.equal(res.classification, "code");
  assert.equal(res.outcomes.length, 1, "one git probe");
  assert.equal(res.outcomes[0].probe_type, "git_reachability");
  assert.equal(res.friction, null);
});

test("gate: code clause fails when sha is unreachable from main", async () => {
  const res = await runPhysicalVerificationGate(
    codeClause(),
    deps({ git: gitUnreachable() }),
  );
  assert.equal(res.passed, false);
  assert.equal(res.friction?.detail.classification, "code");
  assert.equal(res.friction?.detail.failed_probes.length, 1);
  assert.ok(res.friction?.detail.failed_probes[0].observed.includes("reachable=false"));
});

test("gate: code clause git exception ⇒ gate fails", async () => {
  const res = await runPhysicalVerificationGate(
    codeClause(),
    deps({ git: gitThrow("rate limited") }),
  );
  assert.equal(res.passed, false);
  assert.ok(res.outcomes[0].observed.startsWith("exception:"));
});

test("gate: code clause with no shipped_in SHA fails closed", async () => {
  const res = await runPhysicalVerificationGate(
    codeClause({ shipped_in: [] }),
    deps(),
  );
  assert.equal(res.passed, false);
  assert.ok(res.outcomes[0].observed.includes("no recorded merge SHA"));
});

test("gate: code clause with no target_repo fails closed", async () => {
  const res = await runPhysicalVerificationGate(
    codeClause({ target_repo: "" }),
    deps(),
  );
  assert.equal(res.passed, false);
  assert.ok(res.outcomes[0].observed.includes("target_repo missing"));
});

test("gate: code-clause uses main HEAD only (never staging or feature)", async () => {
  // The git client interface only exposes isReachableFromMain — no method to
  // anchor on staging. Assert that the gate calls it with the target_repo
  // and no alternative ref leaks through.
  let captured: { repo?: string; sha?: string } = {};
  const git: GitReachabilityClient = {
    async isReachableFromMain(repo: string, sha: string) {
      captured = { repo, sha };
      return { reachable: true, main_head: "abc" };
    },
  };
  await runPhysicalVerificationGate(codeClause(), deps({ git }));
  assert.equal(captured.repo, "kkef26/nous-agents");
  assert.equal(captured.sha, "deadbeef123");
});

// ─── Single-shot only — gate never retries ──────────────────────────────────

test("gate: a single failure is reported immediately, no internal retry", async () => {
  let calls = 0;
  const sql: SqlExecutor = {
    async execute(_sql: string) {
      calls += 1;
      return { rows: [] };
    },
  };
  // 2 SQL probes in fixture, each should run exactly once.
  await runPhysicalVerificationGate(migrationClause(), deps({ sql }));
  assert.equal(calls, 2, "each probe runs exactly once — never retried");
});

// ─── insertPhysicalGateFriction ─────────────────────────────────────────────

interface InsertCall {
  table: string;
  row: Record<string, unknown>;
}

function makeFrictionDb(opts: { insertError?: { message: string } } = {}) {
  const calls: InsertCall[] = [];
  const db = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.push({ table, row });
          return Promise.resolve({
            data: opts.insertError ? null : { id: "fric-uuid" },
            error: opts.insertError ?? null,
          });
        },
      };
    },
  };
  return { db, calls };
}

test("insertPhysicalGateFriction: writes one structured row with probe detail", async () => {
  const { db, calls } = makeFrictionDb();
  const result = await runPhysicalVerificationGate(
    migrationClause(),
    deps({ sql: sqlError("relation does not exist") }),
  );
  assert.ok(result.friction);
  const res = await insertPhysicalGateFriction(db, {
    payload: result.friction!,
    reported_by: "conductor",
    project: "nous-edge",
  });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  const row = calls[0].row;
  assert.equal(row.source, "physical_verification_gate");
  assert.equal(row.clause_id, "NOUS.MIG.1");
  assert.equal(row.category, "verification_gate");
  assert.equal(row.project, "nous-edge");
  // detail must be the structured object, not stringified
  const detail = row.detail as { failed_probes: unknown[] };
  assert.ok(Array.isArray(detail.failed_probes));
  assert.ok(detail.failed_probes.length > 0);
});

test("insertPhysicalGateFriction: refuses payload with empty failed_probes (no partial inserts)", async () => {
  const { db, calls } = makeFrictionDb();
  const bogus = {
    source: "physical_verification_gate" as const,
    clause_id: "X.Y.Z",
    summary: "no probes",
    detail: {
      classification: "code" as const,
      probe_count: 0,
      failed_probes: [],
      all_outcomes: [],
    },
  };
  const res = await insertPhysicalGateFriction(db, {
    payload: bogus,
    reported_by: "conductor",
    project: "nous-edge",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /failed_probes must be non-empty/);
  assert.equal(calls.length, 0, "no insert SQL when payload is incomplete");
});

test("insertPhysicalGateFriction: surfaces insert error to caller", async () => {
  const { db } = makeFrictionDb({ insertError: { message: "permission denied" } });
  const result = await runPhysicalVerificationGate(
    migrationClause(),
    deps({ sql: sqlError("oops") }),
  );
  assert.ok(result.friction);
  const res = await insertPhysicalGateFriction(db, {
    payload: result.friction!,
    reported_by: "conductor",
    project: "nous-edge",
  });
  assert.equal(res.ok, false);
  assert.match(res.error || "", /permission denied/);
});
