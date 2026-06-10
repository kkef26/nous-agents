-- FEAT.MACGRUBER.5 — investigation log captures one row per intake routed through
-- the failure_class router. Records haiku severity and sonnet fix strategy.

CREATE TABLE IF NOT EXISTS nous.investigation_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_id             uuid        NULL REFERENCES nous.healer_pending_approval(id) ON DELETE SET NULL,
  clause_id             text        NOT NULL,
  failure_class         text        NOT NULL,
  handler               text        NOT NULL,
  severity              text        NOT NULL,
  llm_sonnet_invoked    boolean     NOT NULL DEFAULT false,
  fix_strategy          jsonb       NULL,
  haiku_raw             jsonb       NULL,
  sonnet_raw            jsonb       NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_investigation_log_intake
  ON nous.investigation_log (intake_id);

CREATE INDEX IF NOT EXISTS idx_investigation_log_clause
  ON nous.investigation_log (clause_id, created_at DESC);

COMMENT ON TABLE nous.investigation_log IS
  'MacGruber per-intake investigation trace. severity is the haiku verdict (low/medium/high/critical). fix_strategy holds the parsed sonnet output. llm_sonnet_invoked=false when severity=critical (D11: critical halts at human escalation).';
