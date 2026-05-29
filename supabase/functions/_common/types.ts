// supabase/functions/_common/types.ts
// AGT.1.3 — Shared TypeScript types used by both conductor/* and scoper/*.
// Pure type module: no runtime imports, no side effects. Safe to import anywhere.

// ─── Mode enums ──────────────────────────────────────────────────────────────

export type ConductorMode = "verify" | "merge";
export type ScoperMode = "plan" | "replan";

// ─── Verdict (Conductor verify mode output) ──────────────────────────────────

export type Verdict =
  | "pass"
  | "pass_with_notes"
  | "fail_tactical"
  | "fail_strategic"
  | "block";

export const VERDICTS: readonly Verdict[] = [
  "pass",
  "pass_with_notes",
  "fail_tactical",
  "fail_strategic",
  "block",
] as const;

// ─── Scoper Mode A/B/C outcomes ──────────────────────────────────────────────

export type ScoperOutcome = "A" | "B" | "C";

// ─── Fuse taxonomy (10 canonical kinds) ──────────────────────────────────────
// Used by fuse_manager.ts (AGT.1.1.6) and surfaced in conductor_log.fuse_id FK.
// Kept as a string union here so callers get autocomplete + compile-time check.

export type FuseKind =
  | "edge_version_mismatch"   // git main SHA != live ezbr_sha256
  | "rollback_failure"        // auto-rollback commit itself failed
  | "merge_lock_stale"        // merge_lock older than 10 min, abandoned
  | "ac_verification_failure" // cold-read AC step crashed (not just failed)
  | "compile_failure"         // pillar #1 failed (Vercel build red / typecheck error)
  | "deploy_timeout"          // Vercel deploy poll exceeded 5 min budget
  | "polling_loop_detected"   // loop_guard caught a tight retry pattern
  | "hourly_cap_exceeded"     // loop_guard hourly cap breached
  | "stuck_run"               // heartbeat absent > 60s for an in-flight run
  | "dedup_collision";        // input_hash matched a recent run — duplicate dispatch

export const FUSE_KINDS: readonly FuseKind[] = [
  "edge_version_mismatch",
  "rollback_failure",
  "merge_lock_stale",
  "ac_verification_failure",
  "compile_failure",
  "deploy_timeout",
  "polling_loop_detected",
  "hourly_cap_exceeded",
  "stuck_run",
  "dedup_collision",
] as const;

export type FuseSeverity = "CRITICAL" | "WARNING" | "INFO";

// ─── Pillar names (Conductor 6-pillar quality check) ─────────────────────────

export type PillarName =
  | "compile"
  | "ac_pass"
  | "harmonic"
  | "pattern"
  | "score"
  | "sound";

export type PillarResult = "pass" | "fail" | "warn";

export interface PillarOutcome {
  name: PillarName;
  result: PillarResult;
  detail?: string;
}

// ─── Sentinel scoring (Haiku-4.5, 100-point 5-axis rubric) ───────────────────

export interface SentinelAxes {
  correctness: number;   // 0-30
  robustness: number;    // 0-20
  architecture: number;  // 0-20
  security: number;      // 0-15
  deployability: number; // 0-15
}

export interface SentinelResult {
  score: number; // 0-100
  axes: SentinelAxes;
  rationale: string;
  model: string; // e.g. "claude-haiku-4-5"
}

// ─── Audit trail (Pocock-grade) ──────────────────────────────────────────────

export interface AuditTrail {
  org_id: string | null;             // multi-tenant readiness; default-single-org returns a fixed UUID
  triggered_by_agent_id: string;     // 'kosta' | 'cowork-<sid>' | 'conductor-<run>' | worker_id
  session_id: string;                // originating session
  parent_run_id: string | null;      // links chained runs (verify→amend, plan→replan)
}

// ─── Anthropic usage shape (subset we actually read) ─────────────────────────
// We only depend on fields documented in the public messages API. Keep this
// permissive so future SDK additions don't break the type.

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponseLike {
  usage?: AnthropicUsage;
  model?: string;
}

// ─── Loop guard ──────────────────────────────────────────────────────────────

export interface LoopGuardResult {
  ok: boolean;             // true = proceed; false = blocked
  reason?: string;         // human-readable block reason
  prior_run_id?: string;   // populated when dedup hits a prior run
  retry_after_ms?: number; // suggested backoff (hourly-cap case)
}

// ─── Log rows ────────────────────────────────────────────────────────────────
// Mirrors the SQL schema in migrations/001_scoper_log.sql and 002_conductor_log.sql.
// Optional fields = nullable columns; required fields = NOT NULL.
// Both row shapes intentionally include heartbeat_at + created_at so logging.ts
// can auto-fill them without per-call type assertions.

export interface BaseLogRow {
  run_id?: string;
  project: string;
  step: number;
  step_name: string;
  step_input?: Record<string, unknown>;
  step_output?: Record<string, unknown>;

  org_id?: string | null;
  triggered_by_agent_id?: string;
  session_id?: string;
  parent_run_id?: string | null;

  model_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  estimated_cost_usd?: number;
  actual_cost_usd?: number;

  github_api_calls?: number;
  github_rate_remaining?: number;
  supabase_invocation_id?: string;

  duration_ms?: number;
  heartbeat_at?: string; // ISO timestamp
  error?: string | null;
  created_at?: string;
}

export interface ScoperLogRow extends BaseLogRow {
  feature_id: string;
  mode: ScoperMode;
  reasoning_summary?: string;
  conductor_escalation_id?: string | null;
}

export interface ConductorLogRow extends BaseLogRow {
  mode: ConductorMode;
  dispatch_id?: string | null;
  clause_id?: string | null;
  feature_id?: string | null;

  verdict?: Verdict | null;
  sentinel_score?: number | null;
  sentinel_axes?: SentinelAxes | null;
  retry_count?: number;
  amendment_hint?: Record<string, unknown> | null;
  failure_context?: Record<string, unknown> | null;

  fuse_id?: string | null;
  sentinel_tokens?: number;
  vercel_api_calls?: number;
}

export type LogTable = "scoper_log" | "conductor_log";
export type LogRow = ScoperLogRow | ConductorLogRow;

// ─── Supabase Database type (subset we touch) ───────────────────────────────
// Minimal shape so @supabase/supabase-js can type-check .from(<table>) calls.
// Expand here when conductor/scoper start touching additional nous.* tables.

export interface ConfigRow {
  key: string;
  value: unknown;
}

// ─── Grill decisions table (used by source_material.ts + prerequisites.ts) ───

export interface GrillDecisionRow {
  id: string;
  feature_id: string | null;
  project: string | null;
  decision: string;
  rationale: string | null;
  category: string | null;
  severity: string | null;
  session_id: string | null;
  created_at: string;
}

// ─── Library artifacts table (architecture docs, grill resolutions) ──────────

export interface LibraryArtifactRow {
  id: string;
  project: string | null;
  title: string | null;
  content: string | null;
  artifact_type: string | null;
  tags: string[] | null;
  created_at: string;
}

// ─── Feature source material view (PIPE.CLEANUP D6) ─────────────────────────

export interface FeatureSourceMaterialRow {
  feature_id: string | null;
  project: string | null;
  source_type: string;
  source_id: string;
  title: string | null;
  content: string | null;
  category: string | null;
  severity: string | null;
  created_at: string | null;
}

export interface NousDatabase {
  nous: {
    Tables: {
      config: {
        Row: ConfigRow;
        Insert: ConfigRow;
        Update: Partial<ConfigRow>;
      };
      scoper_log: {
        Row: ScoperLogRow & { run_id: string };
        Insert: ScoperLogRow;
        Update: Partial<ScoperLogRow>;
      };
      conductor_log: {
        Row: ConductorLogRow & { run_id: string };
        Insert: ConductorLogRow;
        Update: Partial<ConductorLogRow>;
      };
      grill_decisions: {
        Row: GrillDecisionRow;
        Insert: Omit<GrillDecisionRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<GrillDecisionRow>;
      };
      library_artifacts: {
        Row: LibraryArtifactRow;
        Insert: Omit<LibraryArtifactRow, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<LibraryArtifactRow>;
      };
    };
    Views: {
      feature_source_material: {
        Row: FeatureSourceMaterialRow;
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// ─── GitHub API typed responses (subset we touch) ────────────────────────────

export interface GitHubRef {
  ref: string;
  node_id: string;
  url: string;
  object: { sha: string; type: string; url: string };
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string; url: string };
  protected: boolean;
}

export interface GitHubCompare {
  status: "ahead" | "behind" | "identical" | "diverged";
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: Array<{ sha: string; commit: { message: string; author: { name: string; email: string; date: string } } }>;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
}

export interface GitHubFileContent {
  type: "file";
  encoding: "base64";
  size: number;
  name: string;
  path: string;
  content: string; // base64
  sha: string;
}

export interface GitHubBlob {
  sha: string;
  url: string;
}

export interface GitHubTree {
  sha: string;
  url: string;
  tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number; url?: string }>;
  truncated: boolean;
}

export interface GitHubCommit {
  sha: string;
  node_id: string;
  url: string;
  tree: { sha: string; url: string };
  parents: Array<{ sha: string; url: string }>;
  message: string;
}

export type DeployStatus =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "error"
  | "not_found";

export interface DeployStatusResult {
  status: DeployStatus;
  url: string | null;
  build_logs_url: string | null;
  sha: string;
}

// ─── Vercel API typed responses (subset we touch) ────────────────────────────

export type VercelReadyState =
  | "QUEUED"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED";

export interface VercelDeployment {
  uid: string;
  url: string;
  state: VercelReadyState;
  readyState: VercelReadyState;
  meta: {
    githubCommitSha?: string;
    githubCommitRef?: string;
    [k: string]: string | undefined;
  };
  createdAt: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string;
}

export interface VercelBuildLog {
  type: "stdout" | "stderr" | "info";
  created: number;
  text: string;
}

