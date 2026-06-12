// NOUS.IDLOCK.5 — Clause-ID allocator client.
//
// Thin wrapper around the nous.allocate_clause_ids(feature_id, prefix, count) RPC.
// The RPC (NOUS.IDLOCK.2) is the SINGLE allocator of clause IDs: it takes an
// advisory lock per prefix, scans the full ID space (including shipped/retired
// tombstones), inserts reserved placeholder rows, and returns the freshly minted
// IDs.
//
// Scoper MUST NOT generate clause IDs by any other route — no local counters,
// no UUIDs, no hashes. See grill_decisions: "Clause IDs are minted ONLY via
// nous.allocate_clause_ids".
//
// Contract:
//  - `allocateClauseIds` returns an ordered array of AllocatedSlot. Callers
//    iterate in order and apply `slot.id` to their stubs/clauses.
//  - A slot may come back as `is_placeholder: true` when the RPC indicates the
//    row was already reserved by a concurrent caller and could not be
//    re-claimed. Callers MUST skip placeholder slots and log a structured
//    warning — they MUST NOT silently overwrite the placeholder.
//  - RPC unavailability is a FATAL halt: the function throws AllocatorUnavailableError.
//    There is no local fallback by design — silent fallback would defeat the
//    DB-enforced uniqueness guarantee.

import { getSupabaseClient, type NousSupabaseClient } from "./lib/common/db.js";

export interface AllocateOptions {
  /** Inject a Supabase client (used by tests). Falls back to getSupabaseClient(). */
  client?: NousSupabaseClient;
}

export interface AllocatedSlot {
  /** The clause ID minted (or already-reserved) by the RPC. */
  id: string;
  /**
   * True when the RPC reports the ID as a pre-existing placeholder
   * (concurrent reservation by another caller). Callers MUST skip these.
   */
  is_placeholder: boolean;
  /** Optional human-readable reason populated by the RPC, e.g. "already_reserved". */
  reason?: string;
}

export interface AllocateResult {
  /** Allocated slots, in request order. May include placeholder entries. */
  slots: AllocatedSlot[];
}

/**
 * Thrown when the allocator RPC is structurally unavailable: the function does
 * not exist, the database is unreachable, or the response shape is unparsable.
 * Scoper treats this as a fatal halt — no clause generation proceeds.
 */
export class AllocatorUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(`allocator unavailable: ${message}`);
    this.name = "AllocatorUnavailableError";
  }
}

interface RpcRow {
  id?: unknown;
  is_placeholder?: unknown;
  placeholder?: unknown;
  reason?: unknown;
}

function parseRpcResponse(data: unknown): AllocatedSlot[] {
  if (data === null || data === undefined) return [];
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  const slots: AllocatedSlot[] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      slots.push({ id: row, is_placeholder: false });
      continue;
    }
    if (row && typeof row === "object") {
      const r = row as RpcRow;
      const id = typeof r.id === "string" ? r.id : "";
      if (!id) {
        throw new AllocatorUnavailableError(`RPC row missing id field: ${JSON.stringify(row).slice(0, 120)}`);
      }
      const flag = r.is_placeholder ?? r.placeholder;
      const is_placeholder = flag === true || flag === "true" || flag === 1;
      const reason = typeof r.reason === "string" ? r.reason : undefined;
      slots.push({ id, is_placeholder, reason });
      continue;
    }
    throw new AllocatorUnavailableError(`RPC row has unexpected shape: ${typeof row}`);
  }
  return slots;
}

/**
 * Allocate `count` clause IDs for `prefix` under `feature_id` via the
 * nous.allocate_clause_ids RPC. Throws AllocatorUnavailableError if the RPC is
 * unreachable or returns an unparsable response. Returned slots may include
 * placeholder entries which callers MUST skip.
 */
export async function allocateClauseIds(
  feature_id: string,
  prefix: string,
  count: number,
  opts: AllocateOptions = {},
): Promise<AllocateResult> {
  if (!feature_id || typeof feature_id !== "string") {
    throw new AllocatorUnavailableError("feature_id required");
  }
  if (!prefix || typeof prefix !== "string") {
    throw new AllocatorUnavailableError("prefix required");
  }
  if (!Number.isInteger(count) || count <= 0) {
    return { slots: [] };
  }

  const sb = opts.client ?? getSupabaseClient();

  let response: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    // deno-lint-ignore no-explicit-any
    response = await (sb as any).rpc("allocate_clause_ids", {
      p_feature_id: feature_id,
      p_prefix: prefix,
      p_count: count,
    });
  } catch (err) {
    throw new AllocatorUnavailableError(
      `RPC call threw: ${(err as Error).message ?? String(err)}`,
      err,
    );
  }

  if (response.error) {
    throw new AllocatorUnavailableError(
      `RPC error${response.error.code ? ` (${response.error.code})` : ""}: ${response.error.message ?? "unknown"}`,
      response.error,
    );
  }

  const slots = parseRpcResponse(response.data);
  return { slots };
}
