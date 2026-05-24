// supabase/functions/conductor/index.ts
// Conductor v2 — router.
//
// Three routes:
//   POST /run    — delegates to verify.ts (AGT.1.1.2) or merge.ts (AGT.1.1.3)
//   GET  /status — liveness + version (AGT.1.1.7)
//   GET  /log    — conductor_log reader (AGT.1.1.7)

import { handleLog, handleStatus } from "./status.ts";
import { handleMerge } from "./merge.ts";
import { handleVerify } from "./verify.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

async function handleRun(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  // Tee the body once so we can read `mode` here and still hand a fresh
  // Request to the delegate (handleVerify / handleMerge call req.json() themselves).
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

async function router(req: Request): Promise<Response> {
  try {
    const { pathname } = new URL(req.url);
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
