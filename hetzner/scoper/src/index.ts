// hetzner/scoper/src/index.ts
// Express server for the Scoper service on port 8090.
// Routes:
//   POST /run     — { mode: "plan" | "replan", ... } delegates to plan.ts / replan.ts
//   POST /audit   — deterministic Pocock codebase quality audit
//   GET  /status  — liveness + 24h Mode A/B/C counts
//   GET  /log     — scoper_log reader (cursor + filters)
//   GET  /health  — basic liveness
//   POST /deploy  — self-deploy for scoper/conductor services

import express, { type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { handleLog, handleStatus } from "./status.js";
import { handlePlan } from "./plan.js";
import { handleReplan } from "./replan.js";
import { handleAudit } from "./audit.js";
import { writeScoperStep } from "./lib/common/logging.js";
import { resolveAuditTrail } from "./lib/common/audit_trail.js";
import { jsonResponse, SCOPER_VERSION } from "./_shared.js";
import { handleDeploy } from "./deploy.js";

const PORT = parseInt(process.env.SCOPER_PORT || "8090", 10);

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

async function logMissingMode(body: Record<string, unknown> | null): Promise<void> {
  try {
    const audit = resolveAuditTrail(body ?? undefined);
    const feature_id = typeof body?.feature_id === "string" ? body.feature_id as string : "unknown";
    await writeScoperStep({
      feature_id,
      project: "unknown",
      mode: "plan",
      step: 1,
      step_name: "router_validation",
      step_input: { received: body ?? null },
      step_output: { error: "mode_required", allowed: ["plan", "replan"] },
      reasoning_summary: "Caller hit /run without a valid mode field.",
      org_id: audit.org_id,
      triggered_by_agent_id: audit.triggered_by_agent_id,
      session_id: audit.session_id,
      parent_run_id: audit.parent_run_id ?? null,
      error: "mode_required",
    });
  } catch (err) {
    console.error("[scoper] failed to log missing_mode:", err);
  }
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.post("/run", async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode = body?.mode;
    if (mode !== "plan" && mode !== "replan") {
      await logMissingMode(body);
      res.status(400).json({
        error: "mode_required",
        message: "mode must be 'plan' or 'replan'",
        allowed: ["plan", "replan"],
      });
      return;
    }
    const webReq = await expressToWebRequest(req);
    const webRes = mode === "plan" ? await handlePlan(webReq) : await handleReplan(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scoper] /run internal error:", message);
    res.status(500).json({ error: "internal", message });
  }
});

app.post("/audit", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleAudit(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scoper] /audit internal error:", message);
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
  res.json({ alive: true, service: "scoper-hetzner", port: PORT, version: SCOPER_VERSION });
});

app.post("/deploy", async (req, res) => {
  try {
    const webReq = await expressToWebRequest(req);
    const webRes = await handleDeploy(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scoper] /deploy internal error:", message);
    res.status(500).json({ error: "internal", message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[scoper] listening on :${PORT}`);
});

// Silence "unused" warning when jsonResponse is referenced indirectly via handlers.
void jsonResponse;
