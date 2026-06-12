// supabase/functions/conductor/frictions.ts
// NOUS.FGCONTRACT.4 — Friction-row writer for the physical verification gate.
//
// The verification gate returns a structured PhysicalGateFriction payload.
// This module persists that payload to nous.friction so the orphan
// reconciler and Kosta's friction dashboard see the failure.

import type { PhysicalGateFriction } from "./verificationGate.ts";

export interface FrictionDbClient {
  // deno-lint-ignore no-explicit-any
  from: (table: string) => {
    // deno-lint-ignore no-explicit-any
    insert: (row: Record<string, unknown>) => any;
  };
}

export interface InsertFrictionInput {
  payload: PhysicalGateFriction;
  // Agent that triggered the gate (typically conductor's audit_trail
  // triggered_by_agent_id). Used for the friction.reported_by field.
  reported_by: string;
  project: string;
  // Severity is constant for this source — the gate only fires on hard
  // failures, never soft regressions. Surfaced as a column so the dashboard
  // can filter without parsing the source string.
  severity?: "blocker" | "high" | "medium";
}

export interface InsertFrictionResult {
  ok: boolean;
  error?: string;
}

// Insert a single friction row. Returns ok=false on insert failure so the
// caller (conductor merge.ts) can log it and continue rather than crash the
// merge orchestration. The friction row is informational; the load-bearing
// gate decision lives in the gate's return value, not in this insert.
export async function insertPhysicalGateFriction(
  db: FrictionDbClient,
  input: InsertFrictionInput,
): Promise<InsertFrictionResult> {
  const { payload, reported_by, project } = input;
  if (!payload || payload.source !== "physical_verification_gate") {
    return { ok: false, error: "payload.source must be physical_verification_gate" };
  }
  if (!payload.clause_id) {
    return { ok: false, error: "payload.clause_id required" };
  }
  if (!payload.detail || !Array.isArray(payload.detail.failed_probes) ||
      payload.detail.failed_probes.length === 0) {
    // Constraint: never insert partial/empty friction rows. The gate only
    // emits a friction payload when at least one probe has failed; an empty
    // failed_probes array here means the caller wired this wrong.
    return { ok: false, error: "detail.failed_probes must be non-empty" };
  }
  const row: Record<string, unknown> = {
    source: payload.source,
    category: "verification_gate",
    severity: input.severity || "blocker",
    project,
    clause_id: payload.clause_id,
    summary: payload.summary,
    detail: payload.detail,
    reported_by,
    created_at: new Date().toISOString(),
  };
  // deno-lint-ignore no-explicit-any
  const res: any = await db.from("friction").insert(row);
  if (res?.error) {
    return { ok: false, error: `friction insert failed: ${res.error.message}` };
  }
  return { ok: true };
}
