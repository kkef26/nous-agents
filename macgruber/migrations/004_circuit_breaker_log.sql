-- FEAT.MACGRUBER.4 — adds the escalated flag to circuit_breaker_log.
-- The table itself was created by 002_add_circuit_breaker_log.sql; this migration
-- extends it with the `escalated` column the breaker middleware sets when a
-- (clause_id, failure_class) pair reaches the per-pair cap.

ALTER TABLE nous.circuit_breaker_log
  ADD COLUMN IF NOT EXISTS escalated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_log_escalated
  ON nous.circuit_breaker_log (escalated)
  WHERE escalated = true;

COMMENT ON COLUMN nous.circuit_breaker_log.escalated IS
  'true once the per-pair (clause_id, failure_class) attempt count has hit the breaker cap (D6: 2 attempts). Set by macgruber/src/middleware/circuitBreaker.ts when it inserts the matching decision_queue row.';
