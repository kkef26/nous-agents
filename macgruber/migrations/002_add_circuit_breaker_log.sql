-- FEAT.MACGRUBER.2 — circuit breaker state table (used by FEAT.MACGRUBER.4 middleware).

CREATE TABLE IF NOT EXISTS nous.circuit_breaker_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  clause_id       text        NOT NULL,
  failure_class   text        NOT NULL,
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  intake_id       uuid        NULL REFERENCES nous.healer_pending_approval(id) ON DELETE SET NULL,
  outcome         text        NULL,
  notes           text        NULL
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_log_pair
  ON nous.circuit_breaker_log (clause_id, failure_class, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_log_window
  ON nous.circuit_breaker_log (attempted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_circuit_breaker_log_intake_attempt
  ON nous.circuit_breaker_log (intake_id, clause_id, failure_class)
  WHERE intake_id IS NOT NULL;

COMMENT ON TABLE nous.circuit_breaker_log IS
  'MacGruber circuit-breaker state. Every investigation attempt writes one row. FEAT.MACGRUBER.4 middleware reads per-pair count and global 60-minute window before allowing further work.';
