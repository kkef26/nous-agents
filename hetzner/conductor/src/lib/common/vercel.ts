// supabase/functions/_common/vercel.ts
// AGT.1.3 — Typed Vercel API client. Conductor merge mode polls deployment
// status by commit SHA; verify mode reads build logs for failed compiles.
//
// Auth: reads `nous.config.VERCEL_TOKEN` (preferred) or env VERCEL_TOKEN.

import { getConfigValue } from "./db.js";
import type { VercelDeployment, VercelBuildLog } from "./types.js";

const VERCEL_API = "https://api.vercel.com";
const USER_AGENT = "nous-agents/_common/vercel.ts";

let cachedToken: string | null = null;
let cachedTeam: string | null | undefined;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const fromConfig = await getConfigValue("VERCEL_TOKEN");
  const tok = fromConfig ?? process.env.VERCEL_TOKEN ?? null;
  if (!tok) {
    throw new Error("vercel: no token — set nous.config.VERCEL_TOKEN or env VERCEL_TOKEN");
  }
  cachedToken = tok;
  return tok;
}

async function getTeamId(): Promise<string | null> {
  if (cachedTeam !== undefined) return cachedTeam;
  const fromConfig = await getConfigValue("VERCEL_TEAM_ID");
  cachedTeam = fromConfig ?? process.env.VERCEL_TEAM_ID ?? null;
  return cachedTeam;
}

function withTeam(qs: URLSearchParams, teamId: string | null): URLSearchParams {
  if (teamId) qs.set("teamId", teamId);
  return qs;
}

interface VercelFetchInit {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  throwOnError?: boolean;
}

async function vercelFetch<T>(path: string, qs: URLSearchParams, init: VercelFetchInit = {}): Promise<T | null> {
  const token = await getToken();
  const teamId = await getTeamId();
  const finalQs = withTeam(qs, teamId);
  const url = `${VERCEL_API}${path}${finalQs.toString() ? `?${finalQs}` : ""}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  const resp = await fetch(url, { method: init.method ?? "GET", headers, body });
  if (!resp.ok) {
    if (init.throwOnError === false) return null;
    const text = await resp.text();
    throw new Error(`vercel ${init.method ?? "GET"} ${path} → ${resp.status}: ${text.slice(0, 500)}`);
  }
  if (resp.status === 204) return null;
  return await resp.json() as T;
}

/**
 * Look up the most recent deployment matching a git commit SHA on a project.
 * Returns null if no deployment for that SHA exists yet (deploy not started).
 *
 * `projectId` accepts either a project ID or project name (Vercel API accepts both).
 */
export async function getDeploymentBySha(
  projectId: string,
  sha: string,
): Promise<VercelDeployment | null> {
  const qs = new URLSearchParams({
    projectId,
    "meta-githubCommitSha": sha,
    limit: "1",
  });
  const result = await vercelFetch<{ deployments: VercelDeployment[] }>(
    "/v6/deployments",
    qs,
    { throwOnError: false },
  );
  if (!result || !result.deployments || result.deployments.length === 0) {
    return null;
  }
  return result.deployments[0];
}

/**
 * Fetch build/runtime logs for a deployment. Returns chronologically ordered
 * log lines.
 */
export async function getBuildLogs(deploymentId: string): Promise<VercelBuildLog[]> {
  const qs = new URLSearchParams({ limit: "1000" });
  const result = await vercelFetch<VercelBuildLog[]>(
    `/v2/deployments/${encodeURIComponent(deploymentId)}/events`,
    qs,
  );
  if (!result) return [];
  // Vercel returns newest-first; normalize to chronological.
  return [...result].sort((a, b) => a.created - b.created);
}

// ─── Test-only ──────────────────────────────────────────────────────────────

export function _resetCacheForTests(): void {
  cachedToken = null;
  cachedTeam = undefined;
}
