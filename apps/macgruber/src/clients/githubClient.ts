/**
 * Thin typed HTTP wrapper for GitHub REST reads.
 *
 * Intentionally narrow: no automatic retries, no SDK helpers, no git writes.
 * The agent loop owns retry policy (per clause D10 constraint). Every method
 * returns either a parsed typed payload or throws a GithubClientError that
 * executors catch and convert into a structured ActionResult.
 */

export class GithubClientError extends Error {
  readonly status?: number;
  readonly category: 'network' | 'http' | 'validation';

  constructor(message: string, category: 'network' | 'http' | 'validation', status?: number) {
    super(message);
    this.name = 'GithubClientError';
    this.category = category;
    this.status = status;
  }
}

export interface GithubBranchPayload {
  name: string;
  commit: { sha: string };
}

export interface GithubCommitRefPayload {
  sha: string;
  url: string;
}

export interface GithubPullRequestPayload {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  head: { sha: string; ref: string };
  base: { ref: string };
}

export interface GithubClientOptions {
  token: string;
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export class GithubClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubClientOptions) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? 'macgruber/1.0';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getBranch(owner: string, repo: string, branch: string): Promise<GithubBranchPayload | null> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`;
    const res = await this.request(path);
    if (res.status === 404) return null;
    const json = (await res.json()) as unknown;
    return assertBranchPayload(json);
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<GithubCommitRefPayload> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
    const res = await this.request(path);
    if (!res.ok) {
      throw new GithubClientError(`commit lookup failed: ${res.status}`, 'http', res.status);
    }
    const json = (await res.json()) as unknown;
    return assertCommitPayload(json);
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<GithubPullRequestPayload> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`;
    const res = await this.request(path);
    if (!res.ok) {
      throw new GithubClientError(`pull request lookup failed: ${res.status}`, 'http', res.status);
    }
    const json = (await res.json()) as unknown;
    return assertPullRequestPayload(json);
  }

  private async request(path: string): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': this.userAgent,
        },
      });
      return res;
    } catch (cause) {
      throw new GithubClientError(
        `network error fetching ${path}: ${(cause as Error).message ?? String(cause)}`,
        'network',
      );
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertBranchPayload(value: unknown): GithubBranchPayload {
  if (!isObject(value) || typeof value.name !== 'string') {
    throw new GithubClientError('branch payload missing name', 'validation');
  }
  const commit = value.commit;
  if (!isObject(commit) || typeof commit.sha !== 'string') {
    throw new GithubClientError('branch payload missing commit.sha', 'validation');
  }
  return { name: value.name, commit: { sha: commit.sha } };
}

function assertCommitPayload(value: unknown): GithubCommitRefPayload {
  if (!isObject(value) || typeof value.sha !== 'string' || typeof value.url !== 'string') {
    throw new GithubClientError('commit payload missing sha/url', 'validation');
  }
  return { sha: value.sha, url: value.url };
}

function assertPullRequestPayload(value: unknown): GithubPullRequestPayload {
  if (!isObject(value) || typeof value.number !== 'number') {
    throw new GithubClientError('pr payload missing number', 'validation');
  }
  const state = value.state;
  if (state !== 'open' && state !== 'closed') {
    throw new GithubClientError(`pr payload invalid state: ${String(state)}`, 'validation');
  }
  if (typeof value.merged !== 'boolean') {
    throw new GithubClientError('pr payload missing merged', 'validation');
  }
  const mergeable = value.mergeable;
  if (mergeable !== null && typeof mergeable !== 'boolean') {
    throw new GithubClientError('pr payload invalid mergeable', 'validation');
  }
  const head = value.head;
  if (!isObject(head) || typeof head.sha !== 'string' || typeof head.ref !== 'string') {
    throw new GithubClientError('pr payload missing head', 'validation');
  }
  const base = value.base;
  if (!isObject(base) || typeof base.ref !== 'string') {
    throw new GithubClientError('pr payload missing base.ref', 'validation');
  }
  return {
    number: value.number,
    state,
    merged: value.merged,
    mergeable,
    head: { sha: head.sha, ref: head.ref },
    base: { ref: base.ref },
  };
}
