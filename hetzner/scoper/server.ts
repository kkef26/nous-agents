// Scoper Node.js server — Express wrapper around Deno handlers
// Port 8790
import http from "node:http";

// Re-export the router from converted index.ts

import { handleStatus, handleLog } from "./status.ts";
import { handlePlan } from "./plan.ts";
import { handleReplan } from "./replan.ts";
import { jsonResponse } from "./_shared.ts";

async function handleRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const mode = body?.mode;
  if (mode !== "plan" && mode !== "replan") {
    return jsonResponse(
      { error: "mode_required", message: "mode must be 'plan' or 'replan'", allowed: ["plan", "replan"] },
      400,
    );
  }
  const proxied = new Request(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (mode === "plan") return await handlePlan(proxied);
  return await handleReplan(proxied);
}

async function router(req: Request): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    const path = pathname.replace(/^\/scoper/, "") || "/";

    if (path === "/run") return await handleRun(req);
    if (path === "/status") return await handleStatus(req);
    if (path === "/log") return await handleLog(req);
    if (path === "/health") return jsonResponse({ alive: true, service: "scoper-hetzner", port: 8790 });

    return jsonResponse({ error: "not_found", path }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scoper] internal error:", message);
    return jsonResponse({ error: "internal", message }, 500);
  }
}

// Node.js HTTP adapter: convert IncomingMessage → Request, Response → ServerResponse
const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = `http://localhost:8790${nodeReq.url || "/"}`;
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

  const webReq = new Request(url, {
    method: nodeReq.method || "GET",
    headers,
    body: body || undefined,
  });

  const webRes = await router(webReq);
  const resBody = await webRes.text();

  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  nodeRes.end(resBody);
});

const PORT = parseInt(process.env.SCOPER_PORT || "8790");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[scoper] listening on :${PORT}`);
});
