/**
 * NOUS.CONDUCTOR.MERGE_GATES.2 + .3 — conductor orchestrator entry point.
 *
 * runConductor wires the previously shipped mergeToStaging
 * (MERGE_GATES.1) to runBuildGate (MERGE_GATES.2) and to runSmokeGate
 * (MERGE_GATES.3). The flow:
 *
 *   1. Attempt the staging merge via mergeImpl.
 *   2. If the merge did not merge (merge_conflict / fetch_failed /
 *      aborted), return status 'not_merged' and DO NOT invoke either
 *      subsequent gate — there is no post-merge tree to check.
 *   3. If the merge merged, invoke runBuildGate against
 *      args.workingDir (the post-merge staging checkout).
 *   4. If the build gate returns any status other than 'passed',
 *      return status 'build_gate_failed'. The clause is NEVER
 *      advanced to a shipped verdict on a non-passed BuildGateResult
 *      (constraint #2 of MERGE_GATES.2). The failing build_output is
 *      forwarded to the optional buildGateFailureSink so callers can
 *      persist the full stdout+stderr into conductor_log.
 *   5. If the build gate passed, invoke runSmokeGate against the
 *      freshly built dist/ (args.newDistPath) and the served location
 *      (args.servedDistPath). runSmokeGate itself handles the
 *      swapDist call on smoke_passed.
 *   6. If runSmokeGate returns any status other than 'smoke_passed',
 *      return status 'smoke_gate_failed' with clauseStatus =
 *      'verification_pending', and forward the failure to the
 *      optional smokeGateFailureSink so callers can surface the
 *      decision_queue row (constraint AC5 of MERGE_GATES.3). The
 *      clause is NEVER advanced to a shipped verdict without an
 *      explicit `smoke_passed` check on SmokeGateResult.status
 *      (constraint #5 of MERGE_GATES.3).
 *   7. If all three phases pass, return status 'shipped' with the
 *      merge, buildGate, and smokeGate results carried through for
 *      downstream logging.
 */

import {
  mergeToStaging,
  type ConductorLogSink,
} from './merge.js';
import { runBuildGate } from './build-gate.js';
import { runSmokeGate } from './smoke-gate.js';
import type {
  BuildGateResult,
  CommandOutput,
  MergeResult,
  SmokeFailReason,
  SmokeGateResult,
} from './types.js';
import {
  DEFAULT_BUILD_GATE_CONFIG,
  DEFAULT_SMOKE_GATE_CONFIG,
  type BuildGateConfig,
  type SmokeGateConfig,
} from './config.js';

export interface ConductorRunArgs {
  repo: string;
  clauseId: string;
  dispatchId?: string;
  headSha: string;
  githubToken: string;
  /** Post-merge staging checkout — the ONLY tree the build gate inspects. */
  workingDir: string;
  /** Absolute path to the freshly built dist/ the smoke gate probes. */
  newDistPath: string;
  /** Absolute path to the served dist/ the atomic swap replaces on pass. */
  servedDistPath: string;
}

export interface BuildGateFailureSink {
  writeBuildGateFailure(entry: {
    clause_id: string;
    dispatch_id?: string;
    status: BuildGateResult['status'];
    build_output?: CommandOutput;
    tsc_output?: CommandOutput;
    reason?: string;
  }): Promise<void>;
}

/**
 * Sink writing the decision_queue row + clause_status update on
 * smoke_failed. Both effects belong together — the caller (conductor
 * plumbing layer) reads clause_status and calls the SQL update; the
 * decision_queue row is the operator-visible surface.
 */
export interface SmokeGateFailureSink {
  writeSmokeGateFailure(entry: {
    clause_id: string;
    dispatch_id?: string;
    clause_status: 'verification_pending';
    reason: SmokeFailReason;
    timestamp: string;
  }): Promise<void>;
}

export interface ConductorRunDeps {
  mergeImpl?: typeof mergeToStaging;
  buildGateImpl?: typeof runBuildGate;
  smokeGateImpl?: typeof runSmokeGate;
  fetchImpl?: typeof fetch;
  conductorLog?: ConductorLogSink;
  buildGateFailureSink?: BuildGateFailureSink;
  smokeGateFailureSink?: SmokeGateFailureSink;
  config?: BuildGateConfig;
  smokeGateConfig?: SmokeGateConfig;
  nowImpl?: () => string;
}

export interface ConductorShipped {
  status: 'shipped';
  merge: MergeResult;
  buildGate: BuildGateResult;
  smokeGate: SmokeGateResult;
}

export interface ConductorNotMerged {
  status: 'not_merged';
  merge: MergeResult;
}

export interface ConductorBuildGateFailed {
  status: 'build_gate_failed';
  merge: MergeResult;
  buildGate: BuildGateResult;
}

export interface ConductorSmokeGateFailed {
  status: 'smoke_gate_failed';
  merge: MergeResult;
  buildGate: BuildGateResult;
  smokeGate: SmokeGateResult;
  clauseStatus: 'verification_pending';
}

export type ConductorRunResult =
  | ConductorShipped
  | ConductorNotMerged
  | ConductorBuildGateFailed
  | ConductorSmokeGateFailed;

export async function runConductor(
  args: ConductorRunArgs,
  deps: ConductorRunDeps = {},
): Promise<ConductorRunResult> {
  const mergeFn = deps.mergeImpl ?? mergeToStaging;
  const buildGateFn = deps.buildGateImpl ?? runBuildGate;
  const smokeGateFn = deps.smokeGateImpl ?? runSmokeGate;
  const now = deps.nowImpl ?? (() => new Date().toISOString());

  const merge = await mergeFn(
    {
      repo: args.repo,
      clauseId: args.clauseId,
      dispatchId: args.dispatchId,
      headSha: args.headSha,
      githubToken: args.githubToken,
    },
    {
      fetchImpl: deps.fetchImpl,
      conductorLog: deps.conductorLog,
    },
  );

  if (merge.status !== 'merged') {
    return { status: 'not_merged', merge };
  }

  const buildGate = await buildGateFn({
    workingDir: args.workingDir,
    config: deps.config ?? DEFAULT_BUILD_GATE_CONFIG,
  });

  if (buildGate.status !== 'passed') {
    if (deps.buildGateFailureSink) {
      await deps.buildGateFailureSink.writeBuildGateFailure({
        clause_id: args.clauseId,
        dispatch_id: args.dispatchId,
        status: buildGate.status,
        build_output:
          buildGate.status === 'tsc_failed' ||
          buildGate.status === 'build_failed'
            ? buildGate.build_output
            : undefined,
        tsc_output:
          buildGate.status === 'build_failed' ? buildGate.tsc_output : undefined,
        reason:
          buildGate.status === 'setup_failed' ? buildGate.reason : undefined,
      });
    }
    return { status: 'build_gate_failed', merge, buildGate };
  }

  const smokeGate = await smokeGateFn({
    newDistPath: args.newDistPath,
    servedDistPath: args.servedDistPath,
    config: deps.smokeGateConfig ?? DEFAULT_SMOKE_GATE_CONFIG,
  });

  if (smokeGate.status !== 'smoke_passed') {
    if (deps.smokeGateFailureSink) {
      await deps.smokeGateFailureSink.writeSmokeGateFailure({
        clause_id: args.clauseId,
        dispatch_id: args.dispatchId,
        clause_status: 'verification_pending',
        reason: smokeGate.reason,
        timestamp: now(),
      });
    }
    return {
      status: 'smoke_gate_failed',
      merge,
      buildGate,
      smokeGate,
      clauseStatus: 'verification_pending',
    };
  }

  return { status: 'shipped', merge, buildGate, smokeGate };
}
