-- AGT.2.1 — Two-Phase Status Model Migration (carwash positions)
-- Extends nous.bible_clauses status CHECK constraint with three intermediate statuses
-- representing the worker → conductor handoff pipeline:
--   build_complete : worker pushed to staging   (set BY worker via L-RECONCILE)
--   verified       : conductor verify passed AC + Sentinel (set BY conductor verify)
--   build_failed   : worker could not complete   (triggers conductor amend/escalate)
--
-- verification_pending stays in the CHECK list (deprecated, no new writes) so the
-- migration is safe to roll forward without coordinating an in-flight writer rename.
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_007_status_model_carwash", "query": "<this file>"})
-- ROLLBACK:
--   ALTER TABLE nous.bible_clauses DROP CONSTRAINT bible_clauses_status_check;
--   ALTER TABLE nous.bible_clauses ADD CONSTRAINT bible_clauses_status_check
--     CHECK (status = ANY (ARRAY['draft','active','shipped','deprecated','retired','verification_pending']));

BEGIN;

-- ── Step 1: row-count snapshot (audit baseline) ────────────────────────────
DO $$
DECLARE
  total_before bigint;
  vp_before    bigint;
BEGIN
  SELECT count(*) INTO total_before FROM nous.bible_clauses;
  SELECT count(*) INTO vp_before    FROM nous.bible_clauses WHERE status='verification_pending';
  RAISE NOTICE '[AGT.2.1] before: total=% verification_pending=%', total_before, vp_before;
END $$;

-- ── Step 2: extend status CHECK with carwash positions ─────────────────────
ALTER TABLE nous.bible_clauses DROP CONSTRAINT bible_clauses_status_check;
ALTER TABLE nous.bible_clauses ADD CONSTRAINT bible_clauses_status_check
  CHECK (status = ANY (ARRAY[
    'draft'::text,
    'active'::text,
    'shipped'::text,
    'deprecated'::text,
    'retired'::text,
    'verification_pending'::text,
    'build_complete'::text,
    'verified'::text,
    'build_failed'::text
  ]));

-- ── Step 3: migrate verification_pending rows ──────────────────────────────
-- Precedence (per AGT.2.1 spec): shipped → build_complete → active.
-- A row that matches multiple conditions only fires the highest-precedence one
-- because subsequent UPDATEs filter on status='verification_pending'.
DO $$
DECLARE
  moved_shipped        bigint;
  moved_build_complete bigint;
  moved_active         bigint;
BEGIN
  -- 3a: shipped_in has at least one entry → shipped
  WITH moved AS (
    UPDATE nous.bible_clauses
    SET status='shipped', updated_at=now()
    WHERE status='verification_pending'
      AND shipped_in IS NOT NULL
      AND array_length(shipped_in, 1) > 0
    RETURNING id
  )
  SELECT count(*) INTO moved_shipped FROM moved;
  RAISE NOTICE '[AGT.2.1] verification_pending → shipped: %', moved_shipped;

  -- 3b: matching complete dispatch → build_complete
  WITH moved AS (
    UPDATE nous.bible_clauses bc
    SET status='build_complete', updated_at=now()
    WHERE bc.status='verification_pending'
      AND EXISTS (
        SELECT 1 FROM nous.dispatch_queue dq
        WHERE dq.clause_id = bc.id AND dq.status='complete'
      )
    RETURNING bc.id
  )
  SELECT count(*) INTO moved_build_complete FROM moved;
  RAISE NOTICE '[AGT.2.1] verification_pending → build_complete: %', moved_build_complete;

  -- 3c: remaining → active (dispatchable again)
  WITH moved AS (
    UPDATE nous.bible_clauses
    SET status='active', updated_at=now()
    WHERE status='verification_pending'
    RETURNING id
  )
  SELECT count(*) INTO moved_active FROM moved;
  RAISE NOTICE '[AGT.2.1] verification_pending → active: %', moved_active;
END $$;

-- ── Step 4: post-migration audit ───────────────────────────────────────────
DO $$
DECLARE
  total_after bigint;
  vp_after    bigint;
BEGIN
  SELECT count(*) INTO total_after FROM nous.bible_clauses;
  SELECT count(*) INTO vp_after    FROM nous.bible_clauses WHERE status='verification_pending';
  RAISE NOTICE '[AGT.2.1] after: total=% verification_pending=%', total_after, vp_after;
  IF vp_after <> 0 THEN
    RAISE EXCEPTION '[AGT.2.1] verification_pending rows remain after migration: %', vp_after;
  END IF;
END $$;

COMMIT;
