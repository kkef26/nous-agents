-- AGT.2.2 — nous.conductor_log
-- Captures every Conductor step (verify or merge mode), with verdict metadata,
-- fuse linkage, audit trail (Pocock-grade), and cost visibility.
--
-- DEPENDS ON: 20260520_003_fuses.sql (for the FK on fuse_id)
-- Apply 003 BEFORE 002 in execution order, or use deferred FK (chosen here).
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_002_conductor_log", "query": "<this file>"})
-- ROLLBACK: DROP TABLE IF EXISTS nous.conductor_log;

BEGIN;

CREATE TABLE IF NOT EXISTS nous.conductor_log (
  -- Identity
  run_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode                    text NOT NULL,                   -- 'verify' | 'merge'
  step                    int  NOT NULL,
  step_name               text NOT NULL,

  -- Scope (always set: verify uses dispatch_id+clause_id; merge uses project)
  dispatch_id             text,                            -- verify mode
  clause_id               text,                            -- verify mode
  project                 text NOT NULL,                   -- always populated
  feature_id              text,                            -- verify mode: from clause's feature_group

  step_input              jsonb,
  step_output             jsonb,

  -- Verdict / amendment metadata (verify mode)
  verdict                 text,                            -- pass | pass_with_notes | fail_tactical | fail_strategic | block
  sentinel_score          int,
  sentinel_axes           jsonb,
  retry_count             int DEFAULT 0,                   -- 0 for first verify, ≤2 for tactical retries
  amendment_hint          jsonb,
  failure_context         jsonb,

  -- Audit trail (Pocock-grade)
  org_id                  uuid,
  triggered_by_agent_id   text,
  session_id              text,
  parent_run_id           uuid REFERENCES nous.conductor_log(run_id) ON DELETE SET NULL,
  fuse_id                 uuid REFERENCES nous.fuses(fuse_id) ON DELETE SET NULL,

  -- Model + cost
  model_used              text,
  tokens_in               int DEFAULT 0,
  tokens_out              int DEFAULT 0,
  sentinel_tokens         int DEFAULT 0,                   -- Haiku scoring sub-tokens
  estimated_cost_usd      numeric(10, 6) DEFAULT 0,
  actual_cost_usd         numeric(10, 6) DEFAULT 0,

  -- External call accounting
  github_api_calls        int DEFAULT 0,
  vercel_api_calls        int DEFAULT 0,
  github_rate_remaining   int,
  supabase_invocation_id  text,

  -- Liveness + errors
  duration_ms             int DEFAULT 0,
  heartbeat_at            timestamptz,
  error                   text,
  created_at              timestamptz DEFAULT now(),

  -- Constraints
  CONSTRAINT conductor_log_mode_check          CHECK (mode IN ('verify', 'merge')),
  CONSTRAINT conductor_log_verdict_check       CHECK (
    verdict IS NULL
    OR verdict IN ('pass', 'pass_with_notes', 'fail_tactical', 'fail_strategic', 'block')
  ),
  CONSTRAINT conductor_log_retry_range         CHECK (retry_count >= 0 AND retry_count <= 2),
  CONSTRAINT conductor_log_sentinel_range      CHECK (sentinel_score IS NULL OR (sentinel_score >= 0 AND sentinel_score <= 100))
);

-- Indexes
CREATE INDEX IF NOT EXISTS conductor_log_dispatch_id_idx ON nous.conductor_log (dispatch_id);
CREATE INDEX IF NOT EXISTS conductor_log_clause_id_idx   ON nous.conductor_log (clause_id);
CREATE INDEX IF NOT EXISTS conductor_log_project_idx     ON nous.conductor_log (project);
CREATE INDEX IF NOT EXISTS conductor_log_feature_id_idx  ON nous.conductor_log (feature_id);
CREATE INDEX IF NOT EXISTS conductor_log_mode_idx        ON nous.conductor_log (mode);
CREATE INDEX IF NOT EXISTS conductor_log_created_at_idx  ON nous.conductor_log (created_at DESC);
CREATE INDEX IF NOT EXISTS conductor_log_org_id_idx      ON nous.conductor_log (org_id);
CREATE INDEX IF NOT EXISTS conductor_log_session_id_idx  ON nous.conductor_log (session_id);
CREATE INDEX IF NOT EXISTS conductor_log_fuse_id_idx     ON nous.conductor_log (fuse_id);
CREATE INDEX IF NOT EXISTS conductor_log_verdict_idx     ON nous.conductor_log (verdict) WHERE verdict IS NOT NULL;

-- RLS
ALTER TABLE nous.conductor_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conductor_log_service_role_all ON nous.conductor_log;
CREATE POLICY conductor_log_service_role_all ON nous.conductor_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;

-- Verification (run separately):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='nous' AND table_name='conductor_log' ORDER BY ordinal_position;
-- Expect ~35 columns.
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid='nous.conductor_log'::regclass AND contype='c';
-- Expect 4 CHECK constraints (mode, verdict, retry_range, sentinel_range).
--
-- FK to fuses:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid='nous.conductor_log'::regclass AND contype='f';
-- Expect fuse_id and parent_run_id FKs.
