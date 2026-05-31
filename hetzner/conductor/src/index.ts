// hetzner/conductor/src/index.ts
// Express server for the Conductor service on port 8091.
// Routes:
//   POST /run           — { mode: "verify" | "merge", ... } delegates to verify.ts / merge.ts
//   POST /batch/verify  — sweep dispatch_queue for completed-but-unverified, run verify on each
//   POST /batch/merge   — scan projects with canonical_repo, merge staging→main per project
//   GET  /status        — liveness + 24h verdict/merge breakdown
//   GET  /log           — conductor_log reader (cursor + filters)
//   GET  /health        — basic liveness

import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { handleLog, handleStatus } from "./status.js";
import { handleMerge } from "./merge.js";
import { handleVerify } from "./verify.js";
import { getSupabaseClient } from "./lib/common/db.js";

const PORT = parseInt(process.env.CONDUCTOR_PORT || "8091", 10);
const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function expressToWebRequest(req: ExpressRequest): Promise<Request> {
  const url = `http://localhost:${PORT}${req.originalUrl || req.url || "/"}`;
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (val == null) continue;
    headers.set(key, Array.isArray(val) ? val.join(", ") : String(val));
  }
  const method = req.method || "GET";
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  }
  return new Request(url, { method, headers, body });
}

async function sendWebResponse(webRes: Response, res: ExpressResponse): Promise<void> {
  const text = await webRes.text();
  res.status(webRes.status);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  res.send(text);
}

async function handleBatchVerify(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json() as Record<string, unknown>; } catch { /* ok */ }
  const limit = Math.min(Number(body?.limit) || 10, 50);
  const sb = getSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pending, error: qErr } = await (sb as any)
    .from("dispatch_queue")
    .select("id, clause_id, status, agent_id")
    .in("status", ["complete", "done"])
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (qErr) return jsonResponse({ error: "query_failed", detail: qErr.message }, 500);
  if (!pending || pending.length === 0) {
    return jsonResponse({ ok: true, message: "no completed dispatches pending verification", verified: 0, results: [] });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatchIds = pending.map((p: any) => p.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: alreadyVerified } = await (sb as any)
    .from("conductor_log")
    .select("dispatch_id")
    .in("dispatch_id", dispatchIds)
    .eq("step_name", "verify")
    .not("verdict", "is", null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verifiedSet = new Set((alreadyVerified || []).map((r: any) => r.dispatch_id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toVerify = pending.filter((p: any) => !verifiedSet.has(p.id));
  if (toVerify.length === 0) {
    return jsonResponse({ ok: true, message: "all completed dispatches already verified", verified: 0, results: [] });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      results.push({ dispatch_id: dispatch.id, clause_id: dispatch.clause_id, error: err.message });
    }
  }
  return jsonResponse({
    ok: true,
    verified: results.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    passed: results.filter((r: any) => r.verdict === "pass").length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    failed: results.filter((r: any) => r.error).length,
    results,
  });
}

async function handleBatchMerge(req: Request): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json() as Record<string, unknown>; } catch { /* ok */ }
  const dryRun = body?.dry_run === true;
  const force = body?.force === true;
  const sb = getSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: projects, error: pErr } = await (sb as any)
    .from("projects")
    .select("tag, canonical_repo")
    .not("canonical_repo", "is", null);
  if (pErr) return jsonResponse({ error: "query_failed", detail: pErr.message }, 500);
  if (!projects || projects.length === 0) {
    return jsonResponse({ ok: true, message: "no projects with canonical_repo", merged: 0, results: [] });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: configRow } = await (sb as any)
    .from("config")
    .select("value")
    .eq("key", "GITHUB_TOKEN")
    .single();
  const ghToken = configRow?.value;
  if (!ghToken) return jsonResponse({ error: "GITHUB_TOKEN not found" }, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: any[] = [];
  for (const proj of projects) {
    if (!proj.canonical_repo) continue;
    try {
      const compareResp = await fetch(
        `https://api.github.com/repos/${proj.canonical_repo}/compare/main...staging`,
        { headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" } },
      );
      if (!compareResp.ok) continue;
      const compare = await compareResp.json();
      if (compare.ahead_by === 0) continue;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      results.push({ project: proj.tag, merged: false, error: err.message });
    }
  }
  return jsonResponse({
    ok: true,
    projects_scanned: projects.length,
    projects_with_changes: results.length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    merged_count: results.filter((r: any) => r.merged).length,
    dry_run: dryRun,
    results,
  });
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.post("/run", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body?.mode;
    if (mode !== "verify" && mode !== "merge") {
      res.status(400).json({ error: "mode must be verify or merge" });
      return;
    }
    const webReq = await expressToWebRequest(req);
    const webRes = mode === "verify" ? await handleVerify(webReq) : await handleMerge(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[conductor] /run internal error:", message);
    res.status(500).json({ error: "internal", message });
  }
});

app.post("/batch/verify", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleBatchVerify(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "internal", message });
  }
});

app.post("/batch/merge", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleBatchMerge(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "internal", message });
  }
});

app.get("/status", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleStatus(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "internal", message });
  }
});

app.get("/log", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleLog(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "internal", message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ alive: true, service: "conductor-hetzner", port: PORT });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[conductor] listening on :${PORT}`);
});
