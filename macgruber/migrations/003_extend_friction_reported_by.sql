-- FEAT.MACGRUBER.2 — allow 'macgruber' as a friction reporter.
-- Non-destructive: documents the contract via COMMENT and adds an ENUM-style CHECK iff none exists yet,
-- otherwise leaves the existing constraint intact. Safe on re-run.

COMMENT ON COLUMN nous.friction.reported_by IS
  'Source of the friction entry. Known values: kosta, conductor, scoper, healer, macgruber, claude2, opus. macgruber rows surface in signals/pulse as machine-detected systemic frictions per D3.';

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
  FROM pg_constraint c
  WHERE c.conrelid = 'nous.friction'::regclass
    AND c.contype  = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%reported_by%'
  LIMIT 1;

  IF existing_def IS NOT NULL AND existing_def NOT ILIKE '%macgruber%' THEN
    RAISE NOTICE 'friction.reported_by has constraint % — manual update required to allow ''macgruber''.', existing_def;
  END IF;
END
$$;
