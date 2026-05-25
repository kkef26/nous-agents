-- AGT.2.3 — Retroactive Reconciliation Sweep
-- One-time idempotent migration that walks every historical dispatch and
-- aligns nous.bible_clauses.status to the two-phase carwash model
-- introduced in 007_status_model_carwash.sql.
--
-- Logic
--   1. For every dispatch_queue row with status='complete':
--      For each clause currently in status NOT IN (shipped, build_complete, verified):
--        - shipped_in has entries → status='shipped', maturity_stage='SHIPPED'
--        - else                     → status='build_complete'
--   2. For verification_pending rows with NO matching dispatch:
--        - shipped_in has entries → status='shipped'
--        - else                     → status='active'   (reset to dispatchable)
--   3. Log count per transition.
--
-- Safety
--   * Single transaction (rollback on error).
--   * Never downgrades: rows already in shipped / build_complete / verified are skipped.
--   * Per-transition counters reported via RAISE NOTICE.
--
-- DEPENDS ON: 007_status_model_carwash.sql (status CHECK must allow new values).
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_008_retroactive_reconcile_sweep", "query": "<this file>"})
-- ROLLBACK: data-only migration — no schema to revert; status transitions stand.

BEGIN;

-- ── Snapshot status distribution before sweep ──────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '[AGT.2.3] status distribution BEFORE sweep:';
  FOR r IN SELECT status, count(*) AS n FROM nous.bible_clauses GROUP BY status ORDER BY status LOOP
    RAISE NOTICE '  %  %', rpad(r.status, 22), r.n;
  END LOOP;
END $$;

-- Reconciliation pass. Counters tracked per transition.
DO $$
DECLARE
  shipped_from_complete_dispatch bigint;
  build_complete_from_dispatch   bigint;
  shipped_from_orphan_vp         bigint;
  active_from_orphan_vp          bigint;
BEGIN
  -- ── 1a: clauses with a matching complete dispatch AND shipped_in entries → shipped ─
  -- Highest precedence: a SHA in shipped_in means production already received this work.
  WITH moved AS (
    UPDATE nous.bible_clauses bc
    SET status='shipped', maturity_stage='SHIPPED', updated_at=now()
    WHERE bc.status NOT IN ('shipped','build_complete','verified')
      AND bc.shipped_in IS NOT NULL
      AND array_length(bc.shipped_in, 1) > 0
      AND EXISTS (
        SELECT 1 FROM nous.dispatch_queue dq
        WHERE dq.clause_id = bc.id AND dq.status='complete'
      )
    RETURNING bc.id
  )
  SELECT count(*) INTO shipped_from_complete_dispatch FROM moved;
  RAISE NOTICE '[AGT.2.3] (dispatch=complete AND shipped_in) → shipped: %', shipped_from_complete_dispatch;

  -- ── 1b: clauses with a matching complete dispatch but NO shipped_in → build_complete ─
  WITH moved AS (
    UPDATE nous.bible_clauses bc
    SET status='build_complete', updated_at=now()
    WHERE bc.status NOT IN ('shipped','build_complete','verified')
      AND (bc.shipped_in IS NULL OR array_length(bc.shipped_in, 1) IS NULL OR array_length(bc.shipped_in, 1) = 0)
      AND EXISTS (
        SELECT 1 FROM nous.dispatch_queue dq
        WHERE dq.clause_id = bc.id AND dq.status='complete'
      )
    RETURNING bc.id
  )
  SELECT count(*) INTO build_complete_from_dispatch FROM moved;
  RAISE NOTICE '[AGT.2.3] (dispatch=complete AND no shipped_in) → build_complete: %', build_complete_from_dispatch;

  -- ── 2a: orphan verification_pending with shipped_in → shipped ─────────────
  WITH moved AS (
    UPDATE nous.bible_clauses bc
    SET status='shipped', updated_at=now()
    WHERE bc.status='verification_pending'
      AND bc.shipped_in IS NOT NULL
      AND array_length(bc.shipped_in, 1) > 0
      AND NOT EXISTS (
        SELECT 1 FROM nous.dispatch_queue dq
        WHERE dq.clause_id = bc.id AND dq.status='complete'
      )
    RETURNING bc.id
  )
  SELECT count(*) INTO shipped_from_orphan_vp FROM moved;
  RAISE NOTICE '[AGT.2.3] (orphan verification_pending AND shipped_in) → shipped: %', shipped_from_orphan_vp;

  -- ── 2b: orphan verification_pending without shipped_in → active (re-dispatchable) ─
  WITH moved AS (
    UPDATE nous.bible_clauses bc
    SET status='active', updated_at=now()
    WHERE bc.status='verification_pending'
      AND NOT EXISTS (
        SELECT 1 FROM nous.dispatch_queue dq
        WHERE dq.clause_id = bc.id AND dq.status='complete'
      )
    RETURNING bc.id
  )
  SELECT count(*) INTO active_from_orphan_vp FROM moved;
  RAISE NOTICE '[AGT.2.3] (orphan verification_pending AND no shipped_in) → active: %', active_from_orphan_vp;

  RAISE NOTICE '[AGT.2.3] summary: shipped+%, build_complete+%, orphan_shipped+%, orphan_active+%, total_changes=%',
    shipped_from_complete_dispatch,
    build_complete_from_dispatch,
    shipped_from_orphan_vp,
    active_from_orphan_vp,
    shipped_from_complete_dispatch + build_complete_from_dispatch +
    shipped_from_orphan_vp + active_from_orphan_vp;
END $$;

-- ── Post-sweep audit ────────────────────────────────────────────────────────
DO $$
DECLARE
  r        record;
  vp_left  bigint;
BEGIN
  RAISE NOTICE '[AGT.2.3] status distribution AFTER sweep:';
  FOR r IN SELECT status, count(*) AS n FROM nous.bible_clauses GROUP BY status ORDER BY status LOOP
    RAISE NOTICE '  %  %', rpad(r.status, 22), r.n;
  END LOOP;

  SELECT count(*) INTO vp_left FROM nous.bible_clauses WHERE status='verification_pending';
  IF vp_left <> 0 THEN
    RAISE EXCEPTION '[AGT.2.3] verification_pending rows remain after sweep: % — investigate before proceeding', vp_left;
  END IF;
END $$;

COMMIT;
