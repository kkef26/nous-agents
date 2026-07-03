/**
 * NOUS.CONDUCTOR.MERGE_GATES.1 — live staging-HEAD merge invariant.
 *
 * The 2026-07-03 stale-lineage incident traced to conductor using a
 * previously observed staging SHA as the merge base. This module closes
 * that gap by making a fresh GitHub REST API fetch of refs/heads/staging
 * an invariant of every merge invocation:
 *
 *   1. fetchStagingHead — independently importable, mockable, calls
 *      the GitHub REST API only. Never reads a local git process, a
 *      file-system ref, a cache, or a session-level value.
 *   2. mergeToStaging — orchestrator body. Calls fetchStagingHead
 *      immediately before the PATCH merge request. If the fetch throws
 *      the merge is hard-aborted; the exception propagates unchanged.
 *      A 409 conflict response is recorded to conductor_log as
 *      'merge_conflict' and the returned status is 'merge_conflict'
 *      (never 'merged'), so the caller must NOT advance the clause.
 */

import type { MergeResult } from './types.js';

const GITHUB_API = 'https://api.github.com';
const STAGING_BRANCH = 'staging';

export class StagingHeadFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'StagingHeadFetchError';
    this.status = status;
  }
}

export class MergeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'MergeApiError';
    this.status = status;
  }
}

export interface FetchStagingHeadOptions {
  repo: string;
  githubToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the LIVE HEAD SHA of origin/staging via the GitHub REST API.
 * The GitHub REST API is the only authoritative source (constraint #1);
 * this function must NEVER be replaced by a local git process, a
 * file-system ref, or a cached SHA.
 *
 * Any non-2xx response OR thrown network error propagates as a
 * StagingHeadFetchError so the caller halts the merge flow
 * (constraint #2, constraint #5 — never downgrade to a warning).
 */
export async function fetchStagingHead(
  opts: FetchStagingHeadOptions,
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const url =
    `${GITHUB_API}/repos/${opts.repo}/git/refs/heads/${STAGING_BRANCH}`;

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${opts.githubToken}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new StagingHeadFetchError(
      `network error fetching staging head: ${msg}`,
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new StagingHeadFetchError(
      `GitHub GET refs/heads/staging returned ${resp.status}: ${
        text.slice(0, 400)
      }`,
      resp.status,
    );
  }

  const body = (await resp.json().catch(() => ({}))) as {
    object?: { sha?: string };
  };
  const sha = body.object?.sha;
  if (!sha || typeof sha !== 'string') {
    throw new StagingHeadFetchError(
      'GitHub GET refs/heads/staging returned no object.sha',
    );
  }
  return sha;
}

export interface ConductorLogSink {
  writeMergeConflict(entry: {
    clause_id: string;
    dispatch_id?: string;
    base_sha: string;
    head_sha: string;
    message: string;
  }): Promise<void>;
}

export interface MergeToStagingArgs {
  repo: string;
  clauseId: string;
  dispatchId?: string;
  headSha: string;
  githubToken: string;
}

export interface MergeToStagingDeps {
  fetchImpl?: typeof fetch;
  fetchStagingHead?: typeof fetchStagingHead;
  conductorLog?: ConductorLogSink;
}

/**
 * Orchestrator merge flow. Fetches the live staging HEAD immediately
 * before issuing the PATCH merge request (constraint #1). Never allows
 * the PATCH to proceed if fetchStagingHead throws (constraint #2).
 * On 409, records merge_conflict in conductor_log and returns a
 * merge_conflict result — the caller must not advance the clause.
 */
export async function mergeToStaging(
  args: MergeToStagingArgs,
  deps: MergeToStagingDeps = {},
): Promise<MergeResult> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const fetchHead = deps.fetchStagingHead ?? fetchStagingHead;

  // Step 3 (rewritten per clause): live staging HEAD is fetched here,
  // ONLY here, and ONLY immediately before the PATCH merge request.
  // Any throw from fetchHead halts the flow — the PATCH is never made.
  const baseSha = await fetchHead({
    repo: args.repo,
    githubToken: args.githubToken,
    fetchImpl: fetchFn,
  });

  const url =
    `${GITHUB_API}/repos/${args.repo}/git/refs/heads/${STAGING_BRANCH}`;
  const resp = await fetchFn(url, {
    method: 'PATCH',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${args.githubToken}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      sha: args.headSha,
      force: false,
    }),
  });

  if (resp.status === 200 || resp.status === 201) {
    const body = (await resp.json().catch(() => ({}))) as {
      object?: { sha?: string };
    };
    return {
      status: 'merged',
      merged_sha: body.object?.sha ?? args.headSha,
      base_sha: baseSha,
      head_sha: args.headSha,
    };
  }

  if (resp.status === 409 || resp.status === 422) {
    const rawText = await resp.text().catch(() => '');
    const message = rawText.slice(0, 400);
    if (deps.conductorLog) {
      await deps.conductorLog.writeMergeConflict({
        clause_id: args.clauseId,
        dispatch_id: args.dispatchId,
        base_sha: baseSha,
        head_sha: args.headSha,
        message,
      });
    }
    return {
      status: 'merge_conflict',
      base_sha: baseSha,
      head_sha: args.headSha,
      message,
    };
  }

  const errText = await resp.text().catch(() => '');
  throw new MergeApiError(
    `GitHub PATCH refs/heads/staging returned ${resp.status}: ${
      errText.slice(0, 400)
    }`,
    resp.status,
  );
}
