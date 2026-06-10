-- FEAT.MACGRUBER.2 — repurpose dormant Healer tables for MacGruber.
-- Non-destructive: only COMMENT and (where required) additive ALTER. No DROP/TRUNCATE.

COMMENT ON TABLE nous.healer_pending_approval IS
  'MacGruber intake staging. Each row is a structured failure payload received via POST /intake, awaiting investigation. Originally created for Healer (NST.18.x), now owned by MacGruber per D5.';

COMMENT ON COLUMN nous.healer_pending_approval.proposal_content IS
  'jsonb: full intake payload from Conductor or Scoper. Schema enforced by macgruber/src/schemas/intakePayload.ts.';

COMMENT ON COLUMN nous.healer_pending_approval.status IS
  'Workflow state. MacGruber values: pending | investigating | strategy_ready | dispatched | escalated | failed.';

COMMENT ON COLUMN nous.healer_pending_approval.parent_run_id IS
  'dispatch_event_id of the failure that produced this intake (links back to the original conductor/scoper run).';

COMMENT ON COLUMN nous.healer_pending_approval.blast_score IS
  'MacGruber-assigned 0-100 severity score from claude-haiku classification. Higher = riskier auto-remediation.';

COMMENT ON TABLE nous.healer_policy IS
  'MacGruber per-installation tuning knobs. auto_dispatch_threshold gates which severities auto-remediate without Kosta review.';

COMMENT ON TABLE nous.fix_registry IS
  'MacGruber-shipped fixes with verification metrics. Used by failureClassRouter to recognise recurring patterns and avoid re-doing solved problems.';
