/**
 * NOUS.CONDUCTOR.MERGE_GATES.2 — conductor orchestrator entry point.
 *
 * runConductor wires the previously shipped mergeToStaging
 * (MERGE_GATES.1) to the new runBuildGate (MERGE_GATES.2). The flow:
 *
 *   1. Attempt the staging merge via mergeImpl.
 *   2. If the merge did not merge (merge_conflict / fetch_failed /
 *      aborted), return status 'not_merged' and DO NOT invoke the
 *      build gate — there is no post-merge tree to check.
 *   3. If the merge merged, invoke runBuildGate against
 *      args.workingDir (the post-merge staging checkout).
 *   4. If the build gate returns any status other than 'passed',
 *      return status 'build_gate_failed'. The clause is NEVER
 *      advanced to a shipped verdict on a non-passed BuildGateResult
 *      (constraint #2). The failing build_output is forwarded to the
 *      optional buildGateFailureSink so callers can persist the full
 *      stdout+stderr into conductor_log (constraint #3).
 *   5. If both phases pass, return status 'shipped' with the merge
 *      and buildGate results carried through for downstream logging.
 */

import {
  mergeToStaging,
  type ConductorLogSink,
} from './merge.js';
import { runBuildGate } from './build-gate.js';
import type {
  BuildGateResult,
  CommandOutput,
  MergeResult,
} from './types.js';
import { DEFAULT_BUILD_GATE_CONFIG, type BuildGateConfig } from './config.js';

export interface ConductorRunArgs {
  repo: string;
  clauseId: string;
  dispatchId?: string;
  headSha: string;
  githubToken: string;
  /** Post-merge staging checkout — the ONLY tree the build gate inspects. */
  workingDir: string;
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

export interface ConductorRunDeps {
  mergeImpl?: typeof mergeToStaging;
  buildGateImpl?: typeof runBuildGate;
  fetchImpl?: typeof fetch;
  conductorLog?: ConductorLogSink;
  buildGateFailureSink?: BuildGateFailureSink;
  config?: BuildGateConfig;
}

export interface ConductorShipped {
  status: 'shipped';
  merge: MergeResult;
  buildGate: BuildGateResult;
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

export type ConductorRunResult =
  | ConductorShipped
  | ConductorNotMerged
  | ConductorBuildGateFailed;

export async function runConductor(
  args: ConductorRunArgs,
  deps: ConductorRunDeps = {},
): Promise<ConductorRunResult> {
  const mergeFn = deps.mergeImpl ?? mergeToStaging;
  const buildGateFn = deps.buildGateImpl ?? runBuildGate;

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

  return { status: 'shipped', merge, buildGate };
}
