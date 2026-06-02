// supabase/functions/_common/db.ts
// AGT.1.3 — Supabase service-role client.
// Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the edge fn environment.
// Throws on missing env so misconfiguration fails loud at boot, not silently at first query.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Node 20 lacks native WebSocket — polyfill globally so supabase-js doesn't throw.
// Scoper/Conductor don't use realtime subscriptions, but supabase-js checks for
// WebSocket availability at client creation time.
// @ts-ignore
if (typeof globalThis.WebSocket === "undefined") {
  // @ts-ignore
  globalThis.WebSocket = require("ws");
}

// Untyped client — many tables touched (features, dispatch_queue, agent_events, …)
// are not enumerated in NousDatabase, so callers already cast to any. Keeping the
// client loosely typed avoids spreading those casts further.
export type NousSupabaseClient = SupabaseClient;

let cached: NousSupabaseClient | null = null;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`db.getSupabaseClient: missing required env var ${name}`);
  }
  return value;
}

/**
 * Returns a memoized service-role Supabase client scoped to the `nous` schema.
 * Service role bypasses RLS — only safe inside trusted edge functions.
 *
 * Throws Error if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset.
 */
export function getSupabaseClient(): NousSupabaseClient {
  if (cached) return cached;

  const url = readEnv("SUPABASE_URL");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");

  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "nous" },
    global: {
      headers: { "x-client-info": "nous-agents/_common/db.ts" },
    },
  }) as unknown as NousSupabaseClient;
  cached = client;
  return client;
}

/**
 * Test-only: reset the memoized client. Call from deno test suites.
 */
export function _resetClientForTests(): void {
  cached = null;
}

/**
 * Lookup a key in nous.config. Returns null if absent.
 * Used by github.ts / vercel.ts to fetch their auth tokens.
 */
export async function getConfigValue(key: string): Promise<string | null> {
  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from("config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) {
    throw new Error(`db.getConfigValue('${key}'): ${error.message}`);
  }
  if (!data) return null;
  // nous.config.value is jsonb; if it's stored as a JSON string, peel it.
  const v = (data as { value: unknown }).value;
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}
