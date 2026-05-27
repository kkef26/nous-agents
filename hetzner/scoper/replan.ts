// supabase/functions/scoper/replan.ts
// AGT.1.2 — Scoper v3 replan mode.
//
// Same 6-step playbook as plan.ts, but Step 1 input includes:
//   - prior_plan_id      (scoper_log run_id of the previous plan)
//   - failure_context    (jsonb from Conductor's strategic escalation)
//
// Step 6 Mode A output includes a `delta_from_prior` field so downstream
// dispatchers can see what changed since the prior plan. Mode B / Mode C
// paths are unchanged.

import { jsonResponse } from "./_shared.ts";
import { runPlan } from "./plan.ts";
import type { PlanRequest } from "./plan.ts";

interface ReplanRequest extends PlanRequest {
  mode: "plan";   // we delegate via runPlan; the runPlan override carries the real mode
  prior_plan_id: string;
  failure_context: Record<string, unknown>;
}

function parseReplanBody(body: unknown): ReplanRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be JSON object" };
  const b = body as Record<string, unknown>;
  if (b.mode !== "replan") return { error: "mode must be 'replan'" };
  if (typeof b.feature_id !== "string" || b.feature_id.length === 0) {
    return { error: "feature_id required" };
  }
  if (typeof b.prior_plan_id !== "string" || b.prior_plan_id.length === 0) {
    return { error: "prior_plan_id required for replan mode" };
  }
  if (!b.failure_context || typeof b.failure_context !== "object") {
    return { error: "failure_context (object) required for replan mode" };
  }
  return {
    mode: "plan",
    feature_id: b.feature_id,
    grill_resolution_id: typeof b.grill_resolution_id === "string" ? b.grill_resolution_id : undefined,
    triggered_by_agent_id: typeof b.triggered_by_agent_id === "string" ? b.triggered_by_agent_id : undefined,
    agent_id: typeof b.agent_id === "string" ? b.agent_id : undefined,
    session_id: typeof b.session_id === "string" ? b.session_id : undefined,
    sid: typeof b.sid === "string" ? b.sid : undefined,
    org_id: typeof b.org_id === "string" ? b.org_id : (b.org_id === null ? null : undefined),
    parent_run_id: typeof b.parent_run_id === "string" ? b.parent_run_id : (b.prior_plan_id as string),
    prior_plan_id: b.prior_plan_id as string,
    failure_context: b.failure_context as Record<string, unknown>,
  };
}

export async function handleReplan(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed", allow: "POST" }, 405);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const parsed = parseReplanBody(body);
  if ("error" in parsed) return jsonResponse({ error: parsed.error }, 400);

  // Delegate to the shared playbook with replan-specific overrides.
  return await runPlan(parsed, body as Record<string, unknown>, {
    mode: "replan",
    prior_plan_id: parsed.prior_plan_id,
    failure_context: parsed.failure_context,
  });
}
