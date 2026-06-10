/**
 * Shared types for MacGruber executors and clients.
 *
 * The action layer is intentionally read-only on the git side: every mutating
 * effect must go through the dispatch/queue HTTP surface so that the agent
 * loop owns retry and idempotency decisions, not the underlying clients.
 */

export type FixActionKind =
  | 'check_branch_exists'
  | 'get_commit_sha'
  | 'get_pr_status'
  | 'cancel_dispatch'
  | 'retrigger_tree';

export interface FixActionBase {
  kind: FixActionKind;
}

export interface CheckBranchExistsAction extends FixActionBase {
  kind: 'check_branch_exists';
  owner: string;
  repo: string;
  branch: string;
}

export interface GetCommitShaAction extends FixActionBase {
  kind: 'get_commit_sha';
  owner: string;
  repo: string;
  ref: string;
}

export interface GetPRStatusAction extends FixActionBase {
  kind: 'get_pr_status';
  owner: string;
  repo: string;
  pull_number: number;
}

export interface CancelDispatchAction extends FixActionBase {
  kind: 'cancel_dispatch';
  dispatch_id: string;
  reason: string;
}

export interface RetriggerTreeAction extends FixActionBase {
  kind: 'retrigger_tree';
  tree_run_id: string;
  reason: string;
}

export type FixAction =
  | CheckBranchExistsAction
  | GetCommitShaAction
  | GetPRStatusAction
  | CancelDispatchAction
  | RetriggerTreeAction;

export interface ActionSuccess<T> {
  success: true;
  data: T;
}

export interface ActionFailure {
  success: false;
  error_class: 'network' | 'http' | 'validation' | 'unknown';
  status?: number;
  message: string;
}

export type ActionResult<T = unknown> = ActionSuccess<T> | ActionFailure;

export interface BranchExistsResult {
  exists: boolean;
  sha?: string;
}

export interface CommitShaResult {
  sha: string;
  ref: string;
}

export interface PRStatusResult {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  head_sha: string;
  base_ref: string;
}

export interface CancelDispatchResult {
  dispatch_id: string;
  cancelled: boolean;
}

export interface RetriggerTreeResult {
  tree_run_id: string;
  accepted: boolean;
}

export interface ExecutorContext {
  github: {
    token: string;
    baseUrl: string;
  };
  dispatch: {
    baseUrl: string;
    apiKey: string;
  };
  clauseId: string | null;
  runId: string | null;
  project: string;
  recordedBy: string;
}
