// Conductor Node.js server — Express wrapper around Deno handlers
// Port 8791
import http from "node:http";

import { handleStatus, handleLog } from "./status.ts";
import { handleMerge } from "./merge.ts";
import { handleVerify } from "./verify.ts";
import { getSupabaseClient } from "../common/db.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function handleRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
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

async function handleBatchVerify(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ok */ }
  const limit = Math.min(Number(body?.limit) || 10, 50);
  const sb = getSupabaseClient();
  const { data: pending, error: qErr } = await (sb as any).from("dispatch_queue").select("id, clause_id, status, agent_id").eq("status", "complete").order("updated_at", { ascending: true }).limit(limit);
  if (qErr) return jsonResponse({ error: "query_failed", detail: qErr.message }, 500);
  if (!pending || pending.length === 0) return jsonResponse({ ok: true, message: "no completed dispatches pending verification", verified: 0, results: [] });
  const dispatchIds = pending.map((p: any) => p.id);
  const { data: alreadyVerified } = await (sb as any).from("conductor_log").select("dispatch_id").in("dispatch_id", dispatchIds).eq("step_name", "emit_verdict");
  const verifiedSet = new Set((alreadyVerified || []).map((r: any) => r.dispatch_id));
  const toVerify = pending.filter((p: any) => !verifiedSet.has(p.id));
  if (toVerify.length === 0) return jsonResponse({ ok: true, message: "all completed dispatches already verified", verified: 0, results: [] });
  const results: any[] = [];
  for (const dispatch of toVerify) {
    try {
      const verifyReq = new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dispatch_id: dispatch.id, clause_id: dispatch.clause_id, agent_id: dispatch.agent_id, triggered_by_agent_id: "conductor-batch-verify" }) });
      const resp = await handleVerify(verifyReq);
      const data = await resp.json();
      results.push({ dispatch_id: dispatch.id, clause_id: dispatch.clause_id, verdict: data?.verdict ?? (resp.ok ? "ok" : "error"), error: resp.ok ? undefined : (data?.error ?? `HTTP ${resp.status}`) });
    } catch (err: any) { results.push({ dispatch_id: dispatch.id, clause_id: dispatch.clause_id, error: err.message }); }
  }
  return jsonResponse({ ok: true, verified: results.length, passed: results.filter((r: any) => r.verdict === "pass").length, failed: results.filter((r: any) => r.error).length, results });
}

async function handleBatchMerge(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* ok */ }
  const dryRun = body?.dry_run === true;
  const force = body?.force === true;
  const sb = getSupabaseClient();
  const { data: projects, error: pErr } = await (sb as any).from("projects").select("tag, canonical_repo").not("canonical_repo", "is", null);
  if (pErr) return jsonResponse({ error: "query_failed", detail: pErr.message }, 500);
  if (!projects || projects.length === 0) return jsonResponse({ ok: true, message: "no projects with canonical_repo", merged: 0, results: [] });
  const { data: configRow } = await (sb as any).from("config").select("value").eq("key", "GITHUB_TOKEN").single();
  const ghToken = configRow?.value;
  if (!ghToken) return jsonResponse({ error: "GITHUB_TOKEN not found" }, 500);
  const results: any[] = [];
  for (const proj of projects) {
    if (!proj.canonical_repo) continue;
    try {
      const compareResp = await fetch(`https://api.github.com/repos/${proj.canonical_repo}/compare/main...staging`, { headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" } });
      if (!compareResp.ok) continue;
      const compare = await compareResp.json();
      if (compare.ahead_by === 0) continue;
      const mergeReq = new Request(req.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: proj.tag, dry_run: dryRun, force, locked_by: "conductor-batch-merge" }) });
      const resp = await handleMerge(mergeReq);
      const data = await resp.json();
      results.push({ project: proj.tag, merged: data?.merged ?? false, reason: data?.reason, commits_merged: data?.commits_merged, error: resp.ok ? undefined : (data?.error ?? `HTTP ${resp.status}`) });
    } catch (err: any) { results.push({ project: proj.tag, merged: false, error: err.message }); }
  }
  return jsonResponse({ ok: true, projects_scanned: projects.length, projects_with_changes: results.length, merged_count: results.filter((r: any) => r.merged).length, dry_run: dryRun, results });
}

async function router(req: Request): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    const path = pathname.replace(/^\/conductor/, "") || "/";
    if (path === "/run") return await handleRun(req);
    if (path === "/batch/verify") return await handleBatchVerify(req);
    if (path === "/batch/merge") return await handleBatchMerge(req);
    if (path === "/status") return await handleStatus(req);
    if (path === "/log") return await handleLog(req);
    if (path === "/health") return jsonResponse({ alive: true, service: "conductor-hetzner", port: 8791 });
    return jsonResponse({ error: "not_found", path }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[conductor] internal error:", message);
    return jsonResponse({ error: "internal", message }, 500);
  }
}

const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = `http://localhost:8791${nodeReq.url || "/"}`;
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeReq.headers)) {
    if (val) headers.set(key, Array.isArray(val) ? val.join(", ") : val);
  }
  let body: string | undefined;
  if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks).toString();
  }
  const webReq = new Request(url, { method: nodeReq.method || "GET", headers, body: body || undefined });
  const webRes = await router(webReq);
  const resBody = await webRes.text();
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  nodeRes.end(resBody);
});

const PORT = parseInt(process.env.CONDUCTOR_PORT || "8791");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[conductor] listening on :${PORT}`);
});
