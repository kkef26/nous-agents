// supabase/functions/scoper/index.ts
// AGT.1.2 — Scoper v3 edge function router.
//
// Three routes:
//   POST /run    — delegates to plan.ts (mode=plan) or replan.ts (mode=replan)
//   GET  /status — liveness + version + 24h breakdown of Mode A/B/C counts
//   GET  /log    — scoper_log reader with cursor + feature_id/mode filters
//
// Missing mode field on /run returns 400 + a scoper_log entry (AC #12).

import { handleLog, handleStatus } from "./status.ts";
import { handlePlan } from "./plan.ts";
import { handleReplan } from "./replan.ts";
import { writeScoperStep } from "../_common/logging.ts";
import { resolveAuditTrail } from "../_common/audit_trail.ts";
import { jsonResponse } from "./_shared.ts";

async function logMissingMode(body: Record<string, unknown> | null): Promise<void> {
  try {
    const audit = resolveAuditTrail(body ?? undefined);
    const feature_id = typeof body?.feature_id === "string" ? body.feature_id as string : "unknown";
    await writeScoperStep({
      feature_id,
      project: "unknown",
      mode: "plan", // CHECK constraint requires one of plan|replan; "plan" is the safe default for malformed input
      step: 1,
      step_name: "router_validation",
      step_input: { received: body ?? null },
      step_output: { error: "mode_required", allowed: ["plan", "replan"] },
      reasoning_summary: "Caller hit /run without a valid mode field (AC #12).",
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id ?? null,
      error: "mode_required",
    });
  } catch (err) {
    // Never let logging failure mask the 400 path
    console.error("[scoper] failed to log missing_mode:", err);
  }
}

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
    // AC #12: Missing mode field returns 400 + scoper_log entry with error mode_required
    await logMissingMode(body);
    return jsonResponse(
      { error: "mode_required", message: "mode must be 'plan' or 'replan'", allowed: ["plan", "replan"] },
      400,
    );
  }

  // Re-wrap the parsed body so the delegate can call req.json() itself.
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

    return jsonResponse({ error: "not_found", path }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scoper] internal error:", message);
    return jsonResponse({ error: "internal", message }, 500);
  }
}

Deno.serve(router);
