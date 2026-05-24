// supabase/functions/conductor/index.ts
// Conductor v2 — router (AGT.1.1.1 + AGT.1.1.2).
//
// Three routes:
//   POST /run    — delegates to verify.ts (AGT.1.1.2) or merge.ts (stub until AGT.1.1.3)
//   GET  /status — liveness + version (AGT.1.1.7)
//   GET  /log    — conductor_log reader (AGT.1.1.7)

import { handleLog, handleStatus } from "./status.ts";
import { handleVerify } from "./verify.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

// merge.ts lands in AGT.1.1.3.
async function runMergeStub(payload: Record<string, unknown>): Promise<Response> {
  return jsonResponse(
    { stub: true, message: "merge.ts not yet implemented", route: "/run", mode: payload.mode },
    501,
  );
}

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

  if (mode === "verify") {
    // handleVerify re-parses the body itself; build a proxy request so it can
    // call req.json() without us double-consuming the original stream.
    const proxyReq = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(body),
    });
    return await handleVerify(proxyReq);
  }

  return await runMergeStub(body);
}

async function router(req: Request): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
    // Strip the edge-function base prefix `/conductor` if present (Supabase
    // edge function routing always mounts under the function name).
    const path = pathname.replace(/^\/conductor/, "") || "/";

    if (path === "/run") return await handleRun(req);
    if (path === "/status") return await handleStatus(req);
    if (path === "/log") return await handleLog(req);

    return jsonResponse({ error: "not_found", path }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[conductor] internal error:", message);
    return jsonResponse({ error: "internal", message }, 500);
  }
}

Deno.serve(router);
