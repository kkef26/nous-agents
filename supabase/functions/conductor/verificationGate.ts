// supabase/functions/conductor/verificationGate.ts
// NOUS.FGCONTRACT.4 — Physical verification gate.
//
// Before a clause can transition from status='build_complete' to
// status='shipped', the Conductor routes it through this gate. The gate
// proves that the clause's artifacts are physically present:
//
//   - Migration clauses: contract.verification SQL probes are executed
//     against the live database. Probes use to_regclass, pg_proc, or
//     information_schema queries to confirm objects exist. Every probe
//     must execute without error AND return a non-empty result for the
//     clause to pass.
//
//   - Code clauses: the recorded merge commit SHA (shipped_in[0]) is
//     checked for reachability from the main branch HEAD of the target
//     repository via GitHub's compare-commits API.
//
// A passing gate authorises the caller to write status='shipped'.
// A failing gate leaves status at 'build_complete' and produces a
// PhysicalGateFriction payload that the caller is expected to persist via
// the frictions writer. The gate itself does NOT write status or friction
// rows; orchestration belongs to the caller (conductor merge.ts).
//
// Single-shot only — the gate never retries a probe internally. Retry
// belongs to the orphan-contradiction reconciler cron, not this gate.

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProbeMethod = "sql" | "grep" | "bash";

export interface VerificationProbe {
  target: string;     // AC id this probe verifies
  method: ProbeMethod;
  command: string;    // SQL expression or shell snippet
  expect: string;     // free-form description of the expected result
}

export interface ClauseToVerify {
  id: string;
  // Parsed contract.verification array. Empty array means we have no probes
  // and must classify as code-clause; the git reachability check is the
  // single deciding signal in that branch.
  probes: VerificationProbe[];
  // Recorded merge SHAs for the clause (bible_clauses.shipped_in). The most
  // recent SHA is checked for reachability from main when there are no SQL
  // probes (code-clause branch).
  shipped_in: string[];
  // Target repository for the git probe (e.g. "kkef26/nous-agents").
  target_repo: string;
}

// Injected dependencies — keeping the gate pure so unit tests pass in mock
// executors and we never reach a live DB or GitHub from a Deno.test() run.
export interface SqlExecutor {
  // Run a SQL statement and return either rows (empty array is allowed) or
  // an error message. Throwing is NOT permitted; the gate catches throws by
  // wrapping the call in tryCatch — but throws are still classified as
  // probe failures via the catch branch.
  execute(sql: string): Promise<{ rows: unknown[]; error?: string }>;
}

export interface GitReachabilityClient {
  // Returns whether `sha` is reachable from the HEAD of `repo`'s main branch.
  // ahead/behind counts surface for the friction payload only; the gate
  // decision is reachable-or-not.
  isReachableFromMain(repo: string, sha: string): Promise<{
    reachable: boolean;
    main_head: string | null;
    ahead_by?: number;
    behind_by?: number;
    error?: string;
  }>;
}

export interface GateDependencies {
  sql: SqlExecutor;
  git: GitReachabilityClient;
}

export interface ProbeOutcome {
  // Echoes the probe's identifiers for friction-row authoring.
  probe_type: ProbeMethod | "git_reachability";
  probe_expression: string;
  target: string;
  expected: string;
  observed: string;
  passed: boolean;
}

export interface PhysicalGateFriction {
  source: "physical_verification_gate";
  clause_id: string;
  // Summary the reconciler can render verbatim into a friction row title.
  summary: string;
  // Full probe-by-probe detail. NEVER empty when passed=false (constraint).
  detail: {
    classification: "migration" | "code";
    probe_count: number;
    failed_probes: ProbeOutcome[];
    all_outcomes: ProbeOutcome[];
  };
}

export interface GateResult {
  passed: boolean;
  classification: "migration" | "code";
  // Every probe (or the single git check), pass-or-fail, for audit logging.
  outcomes: ProbeOutcome[];
  // Populated iff passed === false. The caller is expected to persist this
  // via the frictions writer; this module does NOT write to the friction
  // table directly.
  friction: PhysicalGateFriction | null;
}

// ─── Classification ─────────────────────────────────────────────────────────

// A clause is treated as a migration when ANY probe is a SQL probe. Otherwise
// it's a code clause and the git reachability check is the sole signal. We
// intentionally classify by probe content rather than by clause id pattern,
// so a future code-clause that happens to contain an SQL probe still gets
// the strongest available check.
export function classifyClause(
  probes: VerificationProbe[],
): "migration" | "code" {
  return probes.some((p) => p.method === "sql") ? "migration" : "code";
}

// ─── Pass-rule for SQL probes ───────────────────────────────────────────────

// We don't try to parse the human-readable `expect` field as machine
// semantics. The contract only requires that the probe EXECUTE and produce
// SOME result — execution proves the schema object exists at the live DB.
// This is the load-bearing claim of the gate: "the object is present", not
// "the value of the object equals X".
//
// Exception: a probe whose expect string explicitly says "ERROR" is a
// negative probe — it asserts the SQL must throw. For those, the gate flips
// the pass condition.
function isNegativeProbe(probe: VerificationProbe): boolean {
  return /(^|\b)ERROR(\b|:)/.test(probe.expect);
}

function summarizeRows(rows: unknown[]): string {
  if (rows.length === 0) return "0 rows";
  if (rows.length === 1) return `1 row: ${safeJson(rows[0])}`;
  return `${rows.length} rows; first=${safeJson(rows[0])}`;
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 240 ? s.slice(0, 237) + "..." : s;
  } catch {
    return String(v);
  }
}

// ─── Probe runners ──────────────────────────────────────────────────────────

async function runSqlProbe(
  probe: VerificationProbe,
  sql: SqlExecutor,
): Promise<ProbeOutcome> {
  const negative = isNegativeProbe(probe);
  let observed: string;
  let executionError: string | null = null;
  let rows: unknown[] = [];
  try {
    const res = await sql.execute(probe.command);
    rows = Array.isArray(res?.rows) ? res.rows : [];
    if (res?.error) executionError = res.error;
    observed = res?.error
      ? `error: ${res.error}`
      : summarizeRows(rows);
  } catch (err) {
    // Constraint: thrown errors must produce a gate failure, never silently
    // succeed. Wrap and continue so we still emit a structured outcome.
    executionError = err instanceof Error ? err.message : String(err);
    observed = `exception: ${executionError}`;
  }
  // Pass rules:
  //   negative probe → passed iff execution errored
  //   positive probe → passed iff execution succeeded AND returned ≥1 row
  const passed = negative
    ? executionError !== null
    : executionError === null && rows.length > 0;
  return {
    probe_type: "sql",
    probe_expression: probe.command,
    target: probe.target,
    expected: probe.expect,
    observed,
    passed,
  };
}

async function runGitReachabilityProbe(
  clause: ClauseToVerify,
  git: GitReachabilityClient,
): Promise<ProbeOutcome> {
  if (!clause.target_repo) {
    return {
      probe_type: "git_reachability",
      probe_expression: "isReachableFromMain(<no target_repo>)",
      target: "AC01",
      expected: "shipped_in[0] reachable from main HEAD",
      observed: "skipped: target_repo missing",
      passed: false,
    };
  }
  const sha = clause.shipped_in[0];
  if (!sha) {
    return {
      probe_type: "git_reachability",
      probe_expression: `isReachableFromMain(${clause.target_repo}, <no shipped_in>)`,
      target: "AC01",
      expected: "shipped_in[0] reachable from main HEAD",
      observed: "skipped: no recorded merge SHA",
      passed: false,
    };
  }
  let result: Awaited<ReturnType<typeof git.isReachableFromMain>>;
  try {
    result = await git.isReachableFromMain(clause.target_repo, sha);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      probe_type: "git_reachability",
      probe_expression: `isReachableFromMain(${clause.target_repo}, ${sha})`,
      target: "AC01",
      expected: "shipped_in[0] reachable from main HEAD",
      observed: `exception: ${msg}`,
      passed: false,
    };
  }
  const observed = result.error
    ? `error: ${result.error}`
    : `main_head=${result.main_head ?? "?"} reachable=${result.reachable}` +
      (typeof result.behind_by === "number" ? ` behind_by=${result.behind_by}` : "");
  return {
    probe_type: "git_reachability",
    probe_expression: `isReachableFromMain(${clause.target_repo}, ${sha})`,
    target: "AC01",
    expected: "shipped_in[0] reachable from main HEAD",
    observed,
    passed: !result.error && result.reachable === true,
  };
}

// ─── The gate ───────────────────────────────────────────────────────────────

export async function runPhysicalVerificationGate(
  clause: ClauseToVerify,
  deps: GateDependencies,
): Promise<GateResult> {
  if (!clause.id) {
    throw new Error("runPhysicalVerificationGate: clause.id required");
  }
  const classification = classifyClause(clause.probes ?? []);
  const outcomes: ProbeOutcome[] = [];

  if (classification === "migration") {
    // Run every SQL probe. Non-SQL probes in a migration clause's probe list
    // are skipped silently here — the migration verdict rides only on SQL.
    for (const probe of clause.probes) {
      if (probe.method !== "sql") continue;
      outcomes.push(await runSqlProbe(probe, deps.sql));
    }
    // Defensive: a "migration" classification with zero SQL probes shouldn't
    // happen, but if it does we fail closed.
    if (outcomes.length === 0) {
      outcomes.push({
        probe_type: "sql",
        probe_expression: "<no SQL probes available>",
        target: "AC01",
        expected: "≥1 SQL probe present",
        observed: "no SQL probes were defined",
        passed: false,
      });
    }
  } else {
    outcomes.push(await runGitReachabilityProbe(clause, deps.git));
  }

  const failed = outcomes.filter((o) => !o.passed);
  const passed = failed.length === 0;
  let friction: PhysicalGateFriction | null = null;
  if (!passed) {
    // Constraint: friction detail payload must include probe type, probe
    // expression, and observed result — never partial or empty.
    friction = {
      source: "physical_verification_gate",
      clause_id: clause.id,
      summary: `physical verification gate failed for ${clause.id}: ` +
        `${failed.length}/${outcomes.length} probe(s) did not pass`,
      detail: {
        classification,
        probe_count: outcomes.length,
        failed_probes: failed,
        all_outcomes: outcomes,
      },
    };
  }
  return { passed, classification, outcomes, friction };
}

// ─── Parse contract.verification from bible_clauses ─────────────────────────

// The bible stores contract.verification as a JSON-encoded array OR a string
// containing JSON. This helper centralises parsing so callers don't reinvent
// it (and so we have one place to handle the legacy string form).
export function parseContractVerification(
  raw: unknown,
): VerificationProbe[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: VerificationProbe[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const method = obj.method;
    if (method !== "sql" && method !== "grep" && method !== "bash") continue;
    const command = typeof obj.command === "string" ? obj.command : "";
    const expect = typeof obj.expect === "string" ? obj.expect : "";
    const target = typeof obj.target === "string" ? obj.target : "";
    if (!command || !target) continue;
    out.push({ method, command, expect, target });
  }
  return out;
}
