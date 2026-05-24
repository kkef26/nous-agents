-- AGT.2.5 — Rename nous.scoper_queue → nous.amendment_queue, add owner column
-- Ownership of amendments moves from Scoper (old model) to Conductor (v2 model).
-- Existing scoper_queue is empty (0 rows ever per audit), so rename is safe.
--
-- Apply via Supabase MCP: apply_migration({"name":"agt_005_amendment_queue", "query": "<this file>"})
-- ROLLBACK: ALTER TABLE nous.amendment_queue RENAME TO scoper_queue;
--           ALTER TABLE nous.scoper_queue DROP COLUMN IF EXISTS owner;

BEGIN;

DO $$
BEGIN
  -- If scoper_queue exists and amendment_queue doesn't, rename it
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='nous' AND table_name='scoper_queue')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema='nous' AND table_name='amendment_queue') THEN
    ALTER TABLE nous.scoper_queue RENAME TO amendment_queue;
  END IF;

  -- If neither exists, this migration is a no-op (table will be created by app if needed)
  -- (Idempotent: re-running is safe)

  -- Add owner column if it doesn't exist (only matters if the rename happened)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='nous' AND table_name='amendment_queue')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='nous' AND table_name='amendment_queue' AND column_name='owner') THEN
    ALTER TABLE nous.amendment_queue
      ADD COLUMN owner text NOT NULL DEFAULT 'conductor';

    ALTER TABLE nous.amendment_queue
      ADD CONSTRAINT amendment_queue_owner_check CHECK (owner IN ('conductor', 'scoper'));
  END IF;

  -- Optional: keep a legacy view aliasing scoper_queue → amendment_queue if any
  -- nous-edge SQL functions still reference scoper_queue. Recommend SKIP this and
  -- update those functions explicitly as part of AGT.2.5 / AGT.3 work. Leaving here
  -- as comment for documentation.
  --
  -- CREATE OR REPLACE VIEW nous.scoper_queue AS SELECT * FROM nous.amendment_queue;
END
$$;

COMMIT;

-- Verification (run separately):
-- SELECT EXISTS (SELECT 1 FROM information_schema.tables
--                WHERE table_schema='nous' AND table_name='amendment_queue') AS new_exists,
--        EXISTS (SELECT 1 FROM information_schema.tables
--                WHERE table_schema='nous' AND table_name='scoper_queue') AS old_exists;
-- Expect new_exists=t, old_exists=f.
--
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema='nous' AND table_name='amendment_queue' AND column_name='owner';
-- Expect 1 row with default 'conductor'::text.
--
-- Search for stale references in nous functions:
-- SELECT routine_name FROM information_schema.routines
-- WHERE routine_schema='nous' AND routine_definition ILIKE '%scoper_queue%';
-- Expect 0 rows (or document why kept).
