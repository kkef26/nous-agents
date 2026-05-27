// supabase/functions/conductor/index.ts
// Conductor v2 — router.
//
// Routes:
//   POST /run          — single verify or merge (dispatch_id/clause_id or project)
//   POST /batch/verify — find all completed dispatches pending verification, verify each
//   POST /batch/merge  — find all projects with staging ahead, merge each
//   GET  /status       — liveness + version
//   GET  /log          — conductor_log reader

import { handleLog, handleStatus } from "./status.ts";
import { handleMerge } from "./merge.ts";
import { handleVerify } from "./verify.ts";
import { getSupabaseClient } from "../common/db.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// ─── Single-item /run (existing) ─────────────────────────────────────────────

async function handleRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const mode = body?.mode;
  if (mode !== "verify" && mode !== "merge") {
    return jsonResponse({ error: "mode must be verify or merge" }, 400);
  }

  const proxied = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (mode === "verify") return await handleVerify(proxied);
  return await handleMerge(proxied);
}

// ─── Batch verify: find completed dispatches not yet verified ────────────────

interface BatchVerifyResult {
  dispatch_id: string;
  clause_id: string;
  verdict?: string;
  error?: string;
}

async function handleBatchVerify(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const limit = Math.min(Number(body?.limit) || 10, 50);

  const sb = getSupabaseClient();

  // Find dispatches that completed but haven't been verified yet.
  // dispatch_queue.status = 'complete' means worker fired complete event.
  // We check conductor_log to see if verification already ran for each dispatch.
  // deno-lint-ignore no-explicit-any
  const { data: pending, error: qErr } = await (sb as any)
    .from("dispatch_queue")
    .select("id, clause_id, status, agent_id")
    .eq("status", "complete")
    .order("updated_at", { ascending: true })
    .limit(limit);

  if (qErr) {
    return jsonResponse({ error: "query_failed", detail: qErr.message }, 500);
  }

  if (!pending || pending.length === 0) {
    return jsonResponse({
      ok: true,
      message: "no completed dispatches pending verification",
      verified: 0,
      results: [],
    });
  }

  // Filter out dispatches already verified in conductor_log
  const dispatchIds = pending.map((p: { id: string }) => p.id);
  // deno-lint-ignore no-explicit-any
  const { data: alreadyVerified } = await (sb as any)
    .from("conductor_log")
    .select("dispatch_id")
    .in("dispatch_id", dispatchIds)
    .eq("step_name", "emit_verdict");

  const verifiedSet = new Set(
    (alreadyVerified || []).map((r: { dispatch_id: string }) => r.dispatch_id),
  );
  const toVerify = pending.filter(
    (p: { id: string }) => !verifiedSet.has(p.id),
  );

  if (toVerify.length === 0) {
    return jsonResponse({
      ok: true,
      message: "all completed dispatches already verified",
      verified: 0,
      results: [],
    });
  }

  const results: BatchVerifyResult[] = [];
  for (const dispatch of toVerify) {
    try {
      const verifyReq = new Request(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dispatch_id: dispatch.id,
          clause_id: dispatch.clause_id,
          agent_id: dispatch.agent_id,
          triggered_by_agent_id: "conductor-batch-verify",
        }),
      });
      const resp = await handleVerify(verifyReq);
      const data = await resp.json();
      results.push({
        dispatch_id: dispatch.id,
        clause_id: dispatch.clause_id,
        verdict: data?.verdict ?? (resp.ok ? "ok" : "error"),
        error: resp.ok ? undefined : (data?.error ?? `HTTP ${resp.status}`),
      });
    } catch (err) {
      results.push({
        dispatch_id: dispatch.id,
        clause_id: dispatch.clause_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonResponse({
    ok: true,
    verified: results.length,
    passed: results.filter((r) => r.verdict === "pass").length,
    failed: results.filter((r) => r.error || (r.verdict && r.verdict.startsWith("fail"))).length,
    results,
  });
}

// ─── Batch merge: find projects with staging ahead of main ───────────────────

interface BatchMergeResult {
  project: string;
  merged: boolean;
  reason?: string;
  error?: string;
  commits_merged?: number;
}

async function handleBatchMerge(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const dryRun = body?.dry_run === true;
  const force = body?.force === true;

  const sb = getSupabaseClient();

  // Get all projects with canonical_repo set (those we can merge)
  // deno-lint-ignore no-explicit-any
  const { data: projects, error: pErr } = await (sb as any)
    .from("projects")
    .select("tag, canonical_repo")
    .not("canonical_repo", "is", null);

  if (pErr) {
    return jsonResponse({ error: "query_failed", detail: pErr.message }, 500);
  }

  if (!projects || projects.length === 0) {
    return jsonResponse({
      ok: true,
      message: "no projects with canonical_repo configured",
      merged: 0,
      results: [],
    });
  }

  // For each project, check if staging is ahead of main via GitHub API
  // then call handleConductorMerge for those that are
  // deno-lint-ignore no-explicit-any
  const { data: configRow } = await (sb as any)
    .from("config")
    .select("value")
    .eq("key", "GITHUB_TOKEN")
    .single();
  const ghToken = configRow?.value;
  if (!ghToken) {
    return jsonResponse({ error: "GITHUB_TOKEN not found in nous.config" }, 500);
  }

  const results: BatchMergeResult[] = [];

  for (const proj of projects) {
    const repo = proj.canonical_repo;
    if (!repo) continue;

    // Quick check: is staging ahead of main?
    try {
      const compareResp = await fetch(
        `https://api.github.com/repos/${repo}/compare/main...staging`,
        { headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" } },
      );
      if (!compareResp.ok) {
        // No staging branch or repo issue — skip silently
        continue;
      }
      const compare = await compareResp.json();
      if (compare.ahead_by === 0) {
        // Nothing to merge
        continue;
      }

      // Staging is ahead — trigger merge
      const mergeReq = new Request(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: proj.tag,
          dry_run: dryRun,
          force,
          locked_by: "conductor-batch-merge",
        }),
      });
      const resp = await handleMerge(mergeReq);
      const data = await resp.json();
      results.push({
        project: proj.tag,
        merged: data?.merged ?? false,
        reason: data?.reason,
        commits_merged: data?.commits_merged,
        error: resp.ok ? undefined : (data?.error ?? `HTTP ${resp.status}`),
      });
    } catch (err) {
      results.push({
        project: proj.tag,
        merged: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonResponse({
    ok: true,
    projects_scanned: projects.length,
    projects_with_changes: results.length,
    merged_count: results.filter((r) => r.merged).length,
    dry_run: dryRun,
    results,
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(req: Request): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    const path = pathname.replace(/^\/conductor/, "") || "/";

    if (path === "/run") return await handleRun(req);
    if (path === "/batch/verify") return await handleBatchVerify(req);
    if (path === "/batch/merge") return await handleBatchMerge(req);
    if (path === "/status") return await handleStatus(req);
    if (path === "/log") return await handleLog(req);

    return jsonResponse({ error: "not_found", path }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[conductor] internal error:", message);
    return jsonResponse({ error: "internal", message }, 500);
  }
}

