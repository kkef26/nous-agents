/**
 * Top-level dispatcher: routes a FixAction to the correct executor function,
 * records the outcome in fix_registry, then returns the result to the caller.
 *
 * The fix_registry write happens HERE, not inside individual executors or
 * client wrappers. This keeps the audit trail single-sourced and prevents
 * duplicate or missing rows when an executor short-circuits.
 */

import { GithubClient } from '../clients/githubClient.js';
import { DispatchClient } from '../clients/dispatchClient.js';
import { recordAction, type ParamQueryClient } from '../db/fixRegistry.js';
import { checkBranchExists, getCommitSha, getPRStatus } from './githubReads.js';
import { cancelDispatch, retriggerTree } from './dispatchActions.js';
import type { ActionResult, ExecutorContext, FixAction } from './types.js';

export interface ExecuteActionDeps {
  github: GithubClient;
  dispatch: DispatchClient;
  db: ParamQueryClient;
  context: ExecutorContext;
}

export async function executeAction(
  action: FixAction,
  deps: ExecuteActionDeps,
): Promise<ActionResult> {
  const result = await runAction(action, deps);
  try {
    await recordAction(deps.db, {
      clause_id: deps.context.clauseId,
      run_id: deps.context.runId,
      project: deps.context.project,
      action,
      result,
      recorded_by: deps.context.recordedBy,
    });
  } catch (err) {
    process.stderr.write(
      `[macgruber] fix_registry insert failed for ${action.kind}: ${(err as Error).message ?? String(err)}\n`,
    );
  }
  return result;
}

async function runAction(action: FixAction, deps: ExecuteActionDeps): Promise<ActionResult> {
  switch (action.kind) {
    case 'check_branch_exists':
      return checkBranchExists(deps.github, action);
    case 'get_commit_sha':
      return getCommitSha(deps.github, action);
    case 'get_pr_status':
      return getPRStatus(deps.github, action);
    case 'cancel_dispatch':
      return cancelDispatch(deps.dispatch, action);
    case 'retrigger_tree':
      return retriggerTree(deps.dispatch, action);
    default:
      return assertExhaustive(action);
  }
}

function assertExhaustive(action: never): ActionResult {
  return {
    success: false,
    error_class: 'validation',
    message: `unsupported action kind: ${JSON.stringify(action)}`,
  };
}
