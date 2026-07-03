/**
 * NOUS.CONDUCTOR.MERGE_GATES.1 — shared merge-status literals and
 * MergeResult discriminated union. Every terminal state of the merge
 * flow surfaces through this type so callers can pattern-match on
 * result.status rather than sniffing loose flags.
 *
 * A shipped verdict may only be written for status === 'merged'
 * (constraint #4).
 *
 * NOUS.CONDUCTOR.MERGE_GATES.2 — post-merge two-phase build gate
 * (tsc --noEmit followed by production bundle build). The gate runs
 * only after status === 'merged', against the post-merge staging
 * checkout, and a non-passed BuildGateResult must NEVER be advanced
 * to a shipped verdict.
 */

export type MergeStatus =
  | 'merged'
  | 'merge_conflict'
  | 'fetch_failed'
  | 'aborted';

export interface MergeSuccess {
  status: 'merged';
  merged_sha: string;
  base_sha: string;
  head_sha: string;
}

export interface MergeConflict {
  status: 'merge_conflict';
  base_sha: string;
  head_sha: string;
  message: string;
}

export interface MergeFetchFailed {
  status: 'fetch_failed';
  head_sha: string;
  error: string;
}

export interface MergeAborted {
  status: 'aborted';
  reason: string;
}

export type MergeResult =
  | MergeSuccess
  | MergeConflict
  | MergeFetchFailed
  | MergeAborted;

// -----------------------------------------------------------------------------
// NOUS.CONDUCTOR.MERGE_GATES.2 — build gate

/**
 * Every completed spawn (whether it exited 0 or non-zero) surfaces as
 * a CommandOutput so callers observe the raw stdout+stderr and the
 * exit code exactly as reported. Constraint #3 forbids discarding
 * stdout or stderr from a failing command — both fields are always
 * populated on the failing branch of a BuildGateResult.
 */
export interface CommandOutput {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export type BuildGateStatus =
  | 'passed'
  | 'tsc_failed'
  | 'build_failed'
  | 'setup_failed';

export interface BuildGatePassed {
  status: 'passed';
  tsc: CommandOutput;
  build: CommandOutput;
}

/**
 * tsc --noEmit exited non-zero. The build phase MUST NOT have run.
 * build_output carries the failing tsc invocation's exit_code, stdout,
 * and stderr — persisted verbatim into conductor_log by the caller.
 */
export interface BuildGateTscFailed {
  status: 'tsc_failed';
  build_output: CommandOutput;
}

/**
 * tsc --noEmit passed but the production bundle build exited non-zero.
 * tsc_output retains the passing tsc invocation for downstream context;
 * build_output carries the failing build invocation's exit_code,
 * stdout, and stderr.
 */
export interface BuildGateBuildFailed {
  status: 'build_failed';
  tsc_output: CommandOutput;
  build_output: CommandOutput;
}

/**
 * A precondition of the build gate (working-directory presence, binary
 * resolution from node_modules/.bin) failed before any command ran.
 * The gate reports setup_failed rather than pretending the build
 * succeeded, and the conductor treats setup_failed identically to a
 * failed build phase — never yields a shipped verdict.
 */
export interface BuildGateSetupFailed {
  status: 'setup_failed';
  reason: string;
}

export type BuildGateResult =
  | BuildGatePassed
  | BuildGateTscFailed
  | BuildGateBuildFailed
  | BuildGateSetupFailed;

// -----------------------------------------------------------------------------
// NOUS.CONDUCTOR.MERGE_GATES.3 — pre-swap smoke gate
//
// The 2026-07-03 whole-tree-break decision:
//   "Deploy smoke gate: before overwriting a served dist/, conductor
//    verifies the fresh build serves (HTTP 200 on index) and the entry
//    route mounts without console errors. On failure: keep previous
//    dist, mark clause verification_pending, surface to decision_queue."
//
// The SmokeGateResult union covers exactly two terminal statuses.
// smoke_failed ALWAYS carries a non-optional discriminated reason so
// that `tsc --noEmit` rejects any case branch that omits it (constraint
// #8). Adding a new failure mode requires extending SmokeFailReason,
// which propagates as a compile error to every consumer.

/** Every distinct reason a smoke gate can refuse to pass. */
export type SmokeFailReason =
  | 'http_check_failed'
  | 'headless_mount_error'
  | 'headless_timeout';

export interface SmokeGatePassed {
  status: 'smoke_passed';
}

export interface SmokeGateFailed {
  status: 'smoke_failed';
  /** Non-optional — TS rejects any smoke_failed branch that omits it. */
  reason: SmokeFailReason;
}

export type SmokeGateResult = SmokeGatePassed | SmokeGateFailed;
