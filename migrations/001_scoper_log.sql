-- AGT.2.1 — nous.scoper_log
-- Captures every Scoper step (1-6 per run × N runs), with full audit trail
-- (Pocock-grade) and cost visibility.
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_001_scoper_log", "query": "<this file>"})
-- ROLLBACK: DROP TABLE IF EXISTS nous.scoper_log;

BEGIN;

CREATE TABLE IF NOT EXISTS nous.scoper_log (
  -- Identity
  run_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id              text NOT NULL,
  project                 text NOT NULL,                   -- denormalized for fast filtering

  -- Mode + step
  mode                    text NOT NULL,                   -- 'plan' | 'replan'
  step                    int  NOT NULL,                   -- 1-6
  step_name               text NOT NULL,
  step_input              jsonb,                           -- what step received
  step_output             jsonb,                           -- what step decided
  reasoning_summary       text,                            -- ≤500 chars

  -- Audit trail (Pocock-grade)
  org_id                  uuid,                            -- multi-tenant readiness
  triggered_by_agent_id   text,                            -- 'kosta' | 'cowork-<session>' | 'conductor-<run_id>' | worker_id
  session_id              text,                            -- originating session
  parent_run_id           uuid REFERENCES nous.scoper_log(run_id) ON DELETE SET NULL,
  conductor_escalation_id uuid,                            -- if mode=replan, the conductor verdict that triggered

  -- Model + cost
  model_used              text,
  tokens_in               int  DEFAULT 0,
  tokens_out              int  DEFAULT 0,
  estimated_cost_usd      numeric(10, 6) DEFAULT 0,
  actual_cost_usd         numeric(10, 6) DEFAULT 0,

  -- External call accounting
  github_api_calls        int  DEFAULT 0,
  github_rate_remaining   int,
  supabase_invocation_id  text,

  -- Liveness + errors
  duration_ms             int  DEFAULT 0,
  heartbeat_at            timestamptz,                     -- updated every 10s during long runs
  error                   text,
  created_at              timestamptz DEFAULT now(),

  -- Constraints
  CONSTRAINT scoper_log_mode_check     CHECK (mode IN ('plan', 'replan')),
  CONSTRAINT scoper_log_step_range     CHECK (step >= 1 AND step <= 6)
);

-- Indexes
CREATE INDEX IF NOT EXISTS scoper_log_feature_id_idx  ON nous.scoper_log (feature_id);
CREATE INDEX IF NOT EXISTS scoper_log_mode_idx        ON nous.scoper_log (mode);
CREATE INDEX IF NOT EXISTS scoper_log_created_at_idx  ON nous.scoper_log (created_at DESC);
CREATE INDEX IF NOT EXISTS scoper_log_org_id_idx      ON nous.scoper_log (org_id);
CREATE INDEX IF NOT EXISTS scoper_log_session_id_idx  ON nous.scoper_log (session_id);
CREATE INDEX IF NOT EXISTS scoper_log_project_idx     ON nous.scoper_log (project);

-- RLS
ALTER TABLE nous.scoper_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scoper_log_service_role_all ON nous.scoper_log;
CREATE POLICY scoper_log_service_role_all ON nous.scoper_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Explicit deny for anon and authenticated (no row-level policy = no access)
-- (RLS without permissive policy denies by default for non-service-role.)

COMMIT;

-- Verification (run separately after apply):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema='nous' AND table_name='scoper_log' ORDER BY ordinal_position;
-- Expect ~25 columns.
