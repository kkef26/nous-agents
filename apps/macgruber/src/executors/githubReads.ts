/**
 * GitHub read executors: never throw, always return a structured ActionResult.
 * Clients raise GithubClientError on failure; we catch and classify here.
 */

import { GithubClient, GithubClientError } from '../clients/githubClient.js';
import type {
  ActionResult,
  BranchExistsResult,
  CheckBranchExistsAction,
  CommitShaResult,
  GetCommitShaAction,
  GetPRStatusAction,
  PRStatusResult,
} from './types.js';

export async function checkBranchExists(
  client: GithubClient,
  action: CheckBranchExistsAction,
): Promise<ActionResult<BranchExistsResult>> {
  try {
    const branch = await client.getBranch(action.owner, action.repo, action.branch);
    if (branch === null) {
      return { success: true, data: { exists: false } };
    }
    return { success: true, data: { exists: true, sha: branch.commit.sha } };
  } catch (err) {
    return toFailure(err);
  }
}

export async function getCommitSha(
  client: GithubClient,
  action: GetCommitShaAction,
): Promise<ActionResult<CommitShaResult>> {
  try {
    const commit = await client.getCommit(action.owner, action.repo, action.ref);
    return { success: true, data: { sha: commit.sha, ref: action.ref } };
  } catch (err) {
    return toFailure(err);
  }
}

export async function getPRStatus(
  client: GithubClient,
  action: GetPRStatusAction,
): Promise<ActionResult<PRStatusResult>> {
  try {
    const pr = await client.getPullRequest(action.owner, action.repo, action.pull_number);
    return {
      success: true,
      data: {
        number: pr.number,
        state: pr.state,
        merged: pr.merged,
        mergeable: pr.mergeable,
        head_sha: pr.head.sha,
        base_ref: pr.base.ref,
      },
    };
  } catch (err) {
    return toFailure(err);
  }
}

function toFailure(err: unknown): ActionResult<never> {
  if (err instanceof GithubClientError) {
    return {
      success: false,
      error_class: err.category,
      status: err.status,
      message: err.message,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    error_class: 'unknown',
    message,
  };
}
