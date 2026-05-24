// supabase/functions/_common/db.ts
// Shared Supabase client factory for the Conductor edge function (and siblings).
//
// Uses the service role key so that nous-schema reads/writes bypass RLS.
// Edge functions inject SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY automatically.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

let cached: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (cached) return cached;
  const url = Deno.env.get("SUPABASE_URL");
  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL or service-role key missing from edge env");
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return cached;
}
