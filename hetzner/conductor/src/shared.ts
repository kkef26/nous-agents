// supabase/functions/conductor/shared.ts
// Bridge: merge.ts imports { cors, db, j, e } from "./shared.js".
// This re-exports those from _common/db.ts with matching signatures
// so merge.ts works without modification.

import { getSupabaseClient } from "./lib/common/db.js";

export const db = getSupabaseClient();

export const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "x-api-key, content-type, authorization, x-caller-agent-id, x-claim-venue",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Content-Type": "application/json",
};

export function j(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

export function e(message: string, status = 400): Response {
  return j({ error: message }, status);
}
