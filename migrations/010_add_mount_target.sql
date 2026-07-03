-- 010_add_mount_target.sql
--
-- AGT.SCOPER.SEAM_CLAUSE.1 — machine-readable mount point for component clauses.
--
-- Adds a nullable `mount_target` text column to nous.bible_clauses. The column
-- carries a route path (e.g. "/shifts"), component display name
-- (e.g. "ShiftsBoardChrome"), or CSS selector (e.g. "aside.shifts-board-chrome").
--
-- The Scoper prerequisite gate (scoper/src/clause_validation.ts) enforces that
-- clauses with clause_type='component' MUST have a non-empty mount_target
-- before a plan may proceed. Non-component clauses are unaffected — the column
-- stays nullable so historical rows and non-UI clauses remain valid.
--
-- Downstream consumers (AGT.SCOPER.SEAM_CLAUSE.2 + .3): decomposition writes
-- mount_target during clause enrichment; the deployed-pixel verifier reads it
-- to assert that the target is rendered on the live route after seam clause
-- integration.
--
-- IDEMPOTENCY: uses ADD COLUMN IF NOT EXISTS so the migration runner may call
-- it more than once (test environments, retries, replayed CI). No CHECK
-- constraint on the value shape here — the string encoding (route vs display
-- name vs selector) is intentionally open so future consumers can disambiguate.
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_010_add_mount_target", "query": "<this file>"})
-- ROLLBACK:
--   ALTER TABLE nous.bible_clauses DROP COLUMN IF EXISTS mount_target;

BEGIN;

ALTER TABLE nous.bible_clauses
  ADD COLUMN IF NOT EXISTS mount_target text;

COMMENT ON COLUMN nous.bible_clauses.mount_target IS
  'AGT.SCOPER.SEAM_CLAUSE.1 — machine-readable mount point (route path, component display name, or CSS selector). MANDATORY when clause_type=component; nullable otherwise.';

COMMIT;
