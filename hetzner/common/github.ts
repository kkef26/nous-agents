// supabase/functions/_common/github.ts
// AGT.1.3 — Typed GitHub REST API client for refs, blobs, trees, commits,
// branches, compares, file content, deploy status.
//
// Auth: reads `nous.config.GITHUB_TOKEN` (preferred) or env var GITHUB_TOKEN
// as fallback. Token is memoized per edge-function instance.

import { getConfigValue } from "./db.ts";
import type {
  GitHubRef,
  GitHubBranch,
  GitHubCompare,
  GitHubFileContent,
  GitHubBlob,
  GitHubTree,
  GitHubCommit,
  DeployStatusResult,
  DeployStatus,
} from "./types.ts";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "nous-agents/_common/github.ts";

let cachedToken: string | null = null;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const fromConfig = await getConfigValue("GITHUB_TOKEN");
  const tok = fromConfig ?? process.env.GITHUB_TOKEN ?? null;
  if (!tok) {
    throw new Error(
      "github: no token — set nous.config.GITHUB_TOKEN or env GITHUB_TOKEN",
    );
  }
  cachedToken = tok;
  return tok;
}

interface GhFetchInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  // If true (default), throw on non-2xx. Set false for endpoints where 404 is data.
  throwOnError?: boolean;
}

interface GhResponse<T> {
  status: number;
  rateRemaining: number | null;
  data: T | null;
  // Raw text — present on non-2xx so the caller can surface error context.
  rawText?: string;
}

async function ghFetch<T>(path: string, init: GhFetchInit = {}): Promise<GhResponse<T>> {
  const token = await getToken();
  const url = path.startsWith("https://") ? path : `${GITHUB_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const resp = await fetch(url, { method: init.method ?? "GET", headers, body });
  const rateHdr = resp.headers.get("x-ratelimit-remaining");
  const rateRemaining = rateHdr ? Number(rateHdr) : null;

  const throwOnError = init.throwOnError !== false;
  if (!resp.ok) {
    const text = await resp.text();
    if (throwOnError) {
      throw new Error(`github ${init.method ?? "GET"} ${path} → ${resp.status}: ${text.slice(0, 500)}`);
    }
    return { status: resp.status, rateRemaining, data: null, rawText: text };
  }
  // 204 No Content — return null body.
  if (resp.status === 204) return { status: 204, rateRemaining, data: null };
  const data = await resp.json() as T;
  return { status: resp.status, rateRemaining, data };
}

// ─── Branch / refs ───────────────────────────────────────────────────────────

export async function getBranch(owner: string, repo: string, branch: string): Promise<GitHubBranch> {
  const { data } = await ghFetch<GitHubBranch>(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  if (!data) throw new Error(`github.getBranch: empty response for ${owner}/${repo}#${branch}`);
  return data;
}

export async function getRef(owner: string, repo: string, ref: string): Promise<GitHubRef> {
  // GitHub expects refs like 'heads/main' (no leading 'refs/').
  const normalized = ref.replace(/^refs\//, "");
  const { data } = await ghFetch<GitHubRef>(`/repos/${owner}/${repo}/git/ref/${normalized}`);
  if (!data) throw new Error(`github.getRef: empty response for ${ref}`);
  return data;
}

/**
 * Update a ref to point at a new SHA. Used by Conductor merge mode for the
 * staging → main fast-forward (or force-update when `force=true`).
 */
export async function patchRef(
  owner: string,
  repo: string,
  ref: string,
  sha: string,
  force = false,
): Promise<GitHubRef> {
  const normalized = ref.replace(/^refs\//, "");
  const { data } = await ghFetch<GitHubRef>(`/repos/${owner}/${repo}/git/refs/${normalized}`, {
    method: "PATCH",
    body: { sha, force },
  });
  if (!data) throw new Error(`github.patchRef: empty response for ${ref}`);
  return data;
}

// ─── Compare commits (staging vs main, etc.) ─────────────────────────────────

export async function compareCommits(
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<GitHubCompare> {
  const { data } = await ghFetch<GitHubCompare>(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  if (!data) throw new Error(`github.compareCommits: empty response`);
  return data;
}

// ─── File content (read) ─────────────────────────────────────────────────────

/**
 * Read file content from a specific ref. Returns decoded UTF-8 string + sha.
 * For binary files use getFileRaw instead (this assumes text).
 */
export async function getFileContent(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string }> {
  const { data } = await ghFetch<GitHubFileContent>(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
  );
  if (!data) throw new Error(`github.getFileContent: ${path}@${ref} returned no data`);
  if (data.encoding !== "base64") {
    throw new Error(`github.getFileContent: unexpected encoding ${data.encoding}`);
  }
  // GitHub wraps base64 with newlines every 60 chars.
  const cleaned = data.content.replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  const content = new TextDecoder("utf-8").decode(bytes);
  return { content, sha: data.sha };
}

// ─── Git Data API: blobs, trees, commits ─────────────────────────────────────

export async function createBlob(
  owner: string,
  repo: string,
  content: string,
  encoding: "utf-8" | "base64" = "utf-8",
): Promise<GitHubBlob> {
  const { data } = await ghFetch<GitHubBlob>(`/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    body: { content, encoding },
  });
  if (!data) throw new Error(`github.createBlob: empty response`);
  return data;
}

export interface TreeEntryInput {
  path: string;
  mode: "100644" | "100755" | "040000" | "160000" | "120000";
  type: "blob" | "tree" | "commit";
  sha?: string | null;       // null = delete
  content?: string;          // inline content (mutually exclusive with sha)
}

export async function createTree(
  owner: string,
  repo: string,
  entries: TreeEntryInput[],
  base_tree?: string,
): Promise<GitHubTree> {
  const body: Record<string, unknown> = { tree: entries };
  if (base_tree) body.base_tree = base_tree;
  const { data } = await ghFetch<GitHubTree>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body,
  });
  if (!data) throw new Error(`github.createTree: empty response`);
  return data;
}

export async function createCommit(
  owner: string,
  repo: string,
  message: string,
  tree: string,
  parents: string[],
  author?: { name: string; email: string; date?: string },
): Promise<GitHubCommit> {
  const body: Record<string, unknown> = { message, tree, parents };
  if (author) body.author = author;
  const { data } = await ghFetch<GitHubCommit>(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body,
  });
  if (!data) throw new Error(`github.createCommit: empty response`);
  return data;
}

// ─── Deploy status (GitHub Deployments API) ──────────────────────────────────
// Conductor uses this AND Vercel API; this one wraps GitHub's own deployment
// statuses (useful when Vercel isn't the deploy target — e.g. edge functions).

export async function getDeployStatus(
  owner: string,
  repo: string,
  sha: string,
): Promise<DeployStatusResult> {
  // Find any deployment for the SHA, then read its latest status.
  const { data: deployments } = await ghFetch<Array<{ id: number; sha: string; environment: string }>>(
    `/repos/${owner}/${repo}/deployments?sha=${encodeURIComponent(sha)}`,
    { throwOnError: false },
  );
  if (!deployments || deployments.length === 0) {
    return { status: "not_found", url: null, build_logs_url: null, sha };
  }
  const deploy = deployments[0];
  const { data: statuses } = await ghFetch<Array<{
    state: string;
    environment_url?: string;
    log_url?: string;
    target_url?: string;
  }>>(`/repos/${owner}/${repo}/deployments/${deploy.id}/statuses`);
  if (!statuses || statuses.length === 0) {
    return { status: "queued", url: null, build_logs_url: null, sha };
  }
  const latest = statuses[0];
  const status = normalizeDeployState(latest.state);
  return {
    status,
    url: latest.environment_url ?? latest.target_url ?? null,
    build_logs_url: latest.log_url ?? null,
    sha,
  };
}

function normalizeDeployState(state: string): DeployStatus {
  switch (state) {
    case "queued":      return "queued";
    case "in_progress": return "in_progress";
    case "success":     return "success";
    case "failure":     return "failure";
    case "error":       return "error";
    case "inactive":    return "not_found";
    case "pending":     return "queued";
    default:            return "error";
  }
}

// ─── Test-only ──────────────────────────────────────────────────────────────

export function _resetTokenForTests(): void {
  cachedToken = null;
}
