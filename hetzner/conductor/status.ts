// supabase/functions/conductor/status.ts
// AGT.1.1.7 — /status and /log read handlers backed by nous.conductor_log + nous.fuses.
//
// Replaces the inline stubs in index.ts. Both handlers tolerate empty tables
// (return zero/null) and surface DB errors as 500 responses.

import { getSupabaseClient } from "../common/db.ts";

const VERSION = "conductor-v0.1.0";
const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleStatus(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed", allow: "GET" }, 405);
  }

  const nous = getSupabaseClient();

  // Last run + 24h window come from the same table; the active-fuses count is
  // independent. Run them in parallel.
  const [lastRunRes, recentRes, activeFusesRes] = await Promise.all([
    nous
      .from("conductor_log")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    nous
      .from("conductor_log")
      .select("run_id", { count: "exact", head: true })
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    nous
      .from("fuses")
      .select("fuse_id", { count: "exact", head: true })
      .in("status", ["pending", "resolving"]),
  ]);

  if (lastRunRes.error) {
    return jsonResponse(
      { error: "conductor_log_query_failed", message: lastRunRes.error.message },
      500,
    );
  }
  if (recentRes.error) {
    return jsonResponse(
      { error: "conductor_log_query_failed", message: recentRes.error.message },
      500,
    );
  }

  // nous.fuses may not yet exist (AGT.2.3 migration pending). Treat missing
  // table as zero rather than 500, since /status is a liveness probe.
  let active_fuses_count = 0;
  if (activeFusesRes.error) {
    const msg = activeFusesRes.error.message?.toLowerCase() ?? "";
    if (!msg.includes("does not exist") && !msg.includes("not found")) {
      return jsonResponse(
        { error: "fuses_query_failed", message: activeFusesRes.error.message },
        500,
      );
    }
  } else {
    active_fuses_count = activeFusesRes.count ?? 0;
  }

  return jsonResponse({
    alive: true,
    version: VERSION,
    last_run_at: lastRunRes.data?.created_at ?? null,
    recent_runs: recentRes.count ?? 0,
    active_fuses_count,
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

  const nous = getSupabaseClient();

  // Cursor: anchor on the created_at of after_run_id, then return strictly older rows.
  let cursorTimestamp: string | null = null;
  if (afterRunId) {
    const cursorRes = await nous
      .from("conductor_log")
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
    cursorTimestamp = cursorRes.data.created_at;
  }

  let query = nous
    .from("conductor_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cursorTimestamp) {
    query = query.lt("created_at", cursorTimestamp);
  }

  const { data, error } = await query;
  if (error) {
    return jsonResponse(
      { error: "conductor_log_query_failed", message: error.message },
      500,
    );
  }

  const logs = data ?? [];
  // next_cursor is signalled by a full page; the caller passes the tail run_id
  // back as ?after_run_id to fetch the next page.
  const next_cursor =
    logs.length === limit ? (logs[logs.length - 1] as { run_id: string }).run_id : null;

  return jsonResponse({ logs, next_cursor });
}
