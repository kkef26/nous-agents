// supabase/functions/_common/audit_trail.ts
// AGT.1.3 — Resolve the Pocock-grade audit trail fields from a request body.
//
// Every conductor_log / scoper_log row must carry:
//   org_id, triggered_by_agent_id, session_id, parent_run_id
//
// Callers (router handlers in conductor/index.ts, scoper/index.ts) pass the
// parsed POST body and we extract or synthesize each field with sensible
// defaults. Single-org deployment uses a fixed default UUID; multi-tenant
// future just needs the body to carry org_id.

import type { AuditTrail } from "./types.ts";

// Default org for single-tenant deployment. Stable UUID — never regenerate.
// When multi-tenant arrives, request bodies will carry org_id and this default
// will only apply when omitted (matching today's behavior for solo Kosta runs).
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

// Accepts either an unknown JSON value or a typed object. Permissive on input
// because request bodies come from external callers.
type ReqBody = Record<string, unknown> | null | undefined;

function readString(body: ReqBody, ...keys: string[]): string | null {
  if (!body) return null;
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function generateSessionId(): string {
  // Format: sess-<unix_ms>-<8 hex>. Human-greppable in logs.
  const ms = Date.now();
  const rand = crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `sess-${ms}-${hex}`;
}

/**
 * Resolve the four audit-trail fields from a POST body.
 *
 * Field resolution order (first non-empty wins):
 *  - org_id              ← body.org_id              | DEFAULT_ORG_ID
 *  - triggered_by_agent_id ← body.triggered_by_agent_id | body.agent_id | 'unknown'
 *  - session_id          ← body.session_id          | body.sid | generated
 *  - parent_run_id       ← body.parent_run_id       | body.parent_id | null
 *
 * Never throws. Missing fields get sensible defaults so a malformed caller
 * cannot prevent log rows from being written.
 */
export function resolveAuditTrail(reqBody: ReqBody): AuditTrail {
  const org_id = readString(reqBody, "org_id") ?? DEFAULT_ORG_ID;

  const triggered_by_agent_id =
    readString(reqBody, "triggered_by_agent_id", "agent_id") ?? "unknown";

  const session_id =
    readString(reqBody, "session_id", "sid") ?? generateSessionId();

  const parent_run_id = readString(reqBody, "parent_run_id", "parent_id");

  return { org_id, triggered_by_agent_id, session_id, parent_run_id };
}
