// supabase/functions/scoper/status.ts
// AGT.1.2 — /status and /log read handlers backed by nous.scoper_log.
// Mirrors conductor/status.ts structure so Station drawers can treat both
// agents the same way.

import { getSupabaseClient } from "../_common/db.ts";
import { SCOPER_VERSION, jsonResponse } from "./_shared.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function handleStatus(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed", allow: "GET" }, 405);
  }

  const sb = getSupabaseClient();
  const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [lastRunRes, recentRes, modeARes, modeBRes, modeCRes] = await Promise.all([
    sb
      .from("scoper_log")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from("scoper_log")
      .select("run_id", { count: "exact", head: true })
      .gte("created_at", dayCutoff),
    sb
      .from("scoper_log")
      .select("run_id", { count: "exact", head: true })
      .gte("created_at", dayCutoff)
      .eq("step_name", "emit_mode_a"),
    sb
      .from("scoper_log")
      .select("run_id", { count: "exact", head: true })
      .gte("created_at", dayCutoff)
      .eq("step_name", "emit_mode_b"),
    sb
      .from("scoper_log")
      .select("run_id", { count: "exact", head: true })
      .gte("created_at", dayCutoff)
      .eq("step_name", "emit_mode_c"),
  ]);

  if (lastRunRes.error) {
    return jsonResponse(
      { error: "scoper_log_query_failed", message: lastRunRes.error.message },
      500,
    );
  }
  if (recentRes.error) {
    return jsonResponse(
      { error: "scoper_log_query_failed", message: recentRes.error.message },
      500,
    );
  }

  return jsonResponse({
    alive: true,
    version: SCOPER_VERSION,
    last_run_at: lastRunRes.data?.created_at ?? null,
    recent_runs_24h: recentRes.count ?? 0,
    mode_a_24h: modeARes.count ?? 0,
    mode_b_24h: modeBRes.count ?? 0,
    mode_c_24h: modeCRes.count ?? 0,
  });
}

export async function handleLog(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed", allow: "GET" }, 405);
  }

  const { searchParams } = new URL(req.url);

  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return jsonResponse({ error: "invalid_limit", message: "limit must be a positive integer" }, 400);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const afterRunId = searchParams.get("after_run_id");
  const featureFilter = searchParams.get("feature_id");
  const modeFilter = searchParams.get("mode");

  const sb = getSupabaseClient();

  let cursorTimestamp: string | null = null;
  if (afterRunId) {
    const cursorRes = await sb
      .from("scoper_log")
      .select("created_at")
      .eq("run_id", afterRunId)
      .maybeSingle();
    if (cursorRes.error) {
      return jsonResponse(
        { error: "cursor_lookup_failed", message: cursorRes.error.message },
        500,
      );
    }
    if (!cursorRes.data) {
      return jsonResponse({ error: "cursor_not_found", after_run_id: afterRunId }, 400);
    }
    cursorTimestamp = cursorRes.data.created_at ?? null;
  }

  let query = sb
    .from("scoper_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursorTimestamp) query = query.lt("created_at", cursorTimestamp);
  if (featureFilter) query = query.eq("feature_id", featureFilter);
  if (modeFilter === "plan" || modeFilter === "replan") query = query.eq("mode", modeFilter);

  const { data, error } = await query;
  if (error) {
    return jsonResponse(
      { error: "scoper_log_query_failed", message: error.message },
      500,
    );
  }
  const logs = data ?? [];
  const next_cursor =
    logs.length === limit ? (logs[logs.length - 1] as { run_id: string }).run_id : null;

  return jsonResponse({ logs, next_cursor });
}
