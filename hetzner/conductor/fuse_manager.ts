// supabase/functions/conductor/fuse_manager.ts
//
// Conductor v2 fuse taxonomy CRUD — AGT.1.1.6.
//
// The 10 fuse kinds below match the CHECK constraint on nous.fuses.kind
// (migration 003). createFuse validates `kind` BEFORE the INSERT so callers
// get an explanatory error instead of a raw 23514 from Postgres.
//
// Consumers: verify.ts + merge.ts (AGT.1.1.2, AGT.1.1.3).
//
// Note on typing: NousDatabase (in _common/types.ts, AGT.1.3) does not yet
// declare nous.fuses. We extend it locally with FusesDatabase and cast the
// shared client through `unknown` so this module's queries are still
// fully-typed. Once NousDatabase is widened to include fuses, the cast
// can collapse to a direct assignment.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "../common/db.ts";
import type { NousDatabase } from "../common/types.ts";

// ─── Canonical 10-kind enum ─────────────────────────────────────────────────
// Mirrors `nous.fuses.kind`'s CHECK constraint exactly.

export type FuseKind =
  | "merge_lock_jam"
  | "score_floor_breach"
  | "ac_undefined"
  | "compile_fail"
  | "production_verify_fail"
  | "rogue_active"
  | "unregistered_repo"
  | "remora_silence_kill"
  | "remora_total_kill"
  | "tactical_retry_exhausted";

export type FuseSeverity = "advisory" | "normal" | "critical" | "blocking";

export type FuseStatus = "pending" | "resolving" | "resolved" | "escalated" | "expired";

const FUSE_KINDS: readonly FuseKind[] = [
  "merge_lock_jam",
  "score_floor_breach",
  "ac_undefined",
  "compile_fail",
  "production_verify_fail",
  "rogue_active",
  "unregistered_repo",
  "remora_silence_kill",
  "remora_total_kill",
  "tactical_retry_exhausted",
] as const;

// ─── Row shapes (Row / Insert / Update) ─────────────────────────────────────

export interface FuseRow {
  fuse_id: string;
  kind: FuseKind;
  severity: FuseSeverity;
  project: string;
  clause_id: string | null;
  feature_id: string | null;
  triggered_by_agent_id: string | null;
  session_id: string | null;
  parent_run_id: string | null;
  detail: string;
  proposed_resolution: string | null;
  auto_resolution_path: string | null;
  kosta_escalation_path: string | null;
  status: FuseStatus;
  created_at: string;
  resolving_at: string | null;
  resolved_at: string | null;
  resolved_by_agent_id: string | null;
  resolution_note: string | null;
}

interface FuseInsertRow {
  kind: FuseKind;
  project: string;
  detail: string;
  severity: FuseSeverity;
  clause_id: string | null;
  feature_id: string | null;
  triggered_by_agent_id: string | null;
  session_id: string | null;
  parent_run_id: string | null;
  proposed_resolution: string | null;
  auto_resolution_path: string | null;
  kosta_escalation_path: string | null;
}

interface FuseUpdateRow {
  status?: FuseStatus;
  severity?: FuseSeverity;
  resolving_at?: string | null;
  resolved_at?: string | null;
  resolved_by_agent_id?: string | null;
  resolution_note?: string | null;
}

// ─── Schema extension ───────────────────────────────────────────────────────

type FusesDatabase = NousDatabase & {
  nous: NousDatabase["nous"] & {
    Tables: NousDatabase["nous"]["Tables"] & {
      fuses: {
        Row: FuseRow;
        Insert: FuseInsertRow;
        Update: FuseUpdateRow;
      };
    };
  };
};

function db(): SupabaseClient<FusesDatabase, "nous"> {
  return getSupabaseClient() as unknown as SupabaseClient<FusesDatabase, "nous">;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CreateFuseOpts {
  kind: FuseKind;
  project: string;
  detail: string;
  severity?: FuseSeverity;
  clause_id?: string;
  feature_id?: string;
  triggered_by_agent_id?: string;
  session_id?: string;
  parent_run_id?: string;
  proposed_resolution?: string;
  auto_resolution_path?: string;
  kosta_escalation_path?: string;
}

function assertFuseKind(kind: string): asserts kind is FuseKind {
  if (!FUSE_KINDS.includes(kind as FuseKind)) {
    throw new Error(
      `fuse_manager.createFuse: invalid kind="${kind}". ` +
        `Must be one of: ${FUSE_KINDS.join(", ")}.`,
    );
  }
}

export async function createFuse(opts: CreateFuseOpts): Promise<{ fuse_id: string }> {
  assertFuseKind(opts.kind);

  if (!opts.project || opts.project.trim() === "") {
    throw new Error("fuse_manager.createFuse: project is required");
  }
  if (!opts.detail || opts.detail.trim() === "") {
    throw new Error("fuse_manager.createFuse: detail is required");
  }

  const row: FuseInsertRow = {
    kind: opts.kind,
    project: opts.project,
    detail: opts.detail,
    severity: opts.severity ?? "normal",
    clause_id: opts.clause_id ?? null,
    feature_id: opts.feature_id ?? null,
    triggered_by_agent_id: opts.triggered_by_agent_id ?? null,
    session_id: opts.session_id ?? null,
    parent_run_id: opts.parent_run_id ?? null,
    proposed_resolution: opts.proposed_resolution ?? null,
    auto_resolution_path: opts.auto_resolution_path ?? null,
    kosta_escalation_path: opts.kosta_escalation_path ?? null,
  };

  const { data, error } = await db()
    .from("fuses")
    .insert(row)
    .select("fuse_id")
    .single();

  if (error) {
    throw new Error(`fuse_manager.createFuse: insert failed — ${error.message}`);
  }
  return { fuse_id: data.fuse_id };
}

export async function getActiveFuses(project: string): Promise<FuseRow[]> {
  if (!project || project.trim() === "") {
    throw new Error("fuse_manager.getActiveFuses: project is required");
  }

  const { data, error } = await db()
    .from("fuses")
    .select("*")
    .eq("project", project)
    .in("status", ["pending", "resolving"])
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`fuse_manager.getActiveFuses: select failed — ${error.message}`);
  }
  return data ?? [];
}

export async function clearFuse(fuse_id: string, note: string): Promise<void> {
  if (!fuse_id || fuse_id.trim() === "") {
    throw new Error("fuse_manager.clearFuse: fuse_id is required");
  }
  if (!note || note.trim() === "") {
    throw new Error("fuse_manager.clearFuse: note is required");
  }

  const update: FuseUpdateRow = {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolution_note: note,
  };

  const { error } = await db()
    .from("fuses")
    .update(update)
    .eq("fuse_id", fuse_id);

  if (error) {
    throw new Error(`fuse_manager.clearFuse: update failed — ${error.message}`);
  }
}
