-- 009_macgruber_fix_registry.sql
--
-- MacGruber action audit trail (FEAT.MACGRUBER.6).
--
-- The fix_registry table already exists in nous (originally created for
-- systemic-fix bookkeeping). This migration extends it with the action-level
-- columns MacGruber needs:
--   clause_id       — bible clause that triggered the remediation
--   run_id          — pipeline run that surfaced the failure
--   action          — FixAction.kind discriminator
--   action_result   — full structured ActionResult payload
--   executed_at     — when the action returned (success or failure)
--
-- All columns are nullable and additive so existing rows are unaffected.
-- MacGruber rows are further distinguished by created_by='macgruber' and
-- fix_type='action'.

CREATE TABLE IF NOT EXISTS nous.fix_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project text,
  failure_description text,
  change_made jsonb,
  verification_metric jsonb,
  status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  fix_type text
);

ALTER TABLE nous.fix_registry
  ADD COLUMN IF NOT EXISTS clause_id text,
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS action_result jsonb,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

CREATE INDEX IF NOT EXISTS fix_registry_clause_id_idx
  ON nous.fix_registry (clause_id)
  WHERE clause_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fix_registry_run_id_idx
  ON nous.fix_registry (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS fix_registry_action_idx
  ON nous.fix_registry (fix_type, executed_at DESC)
  WHERE fix_type = 'action';
