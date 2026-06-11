/**
 * HTTP /intake route — receives push events from Conductor and Scoper.
 *
 * Thin shell: validate against the intake contract (contract/intakeContract),
 * then delegate to processIntakeEvent — the same function the poller calls,
 * so push and poll produce identical friction and fix-registry records.
 *
 * Deps are provided per-event via a factory so the executor context carries
 * the event's clause/run identity into the fix_registry audit trail.
 */

import { parseIntakeBody } from '../contract/intakeContract.js';
import {
  processIntakeEvent,
  type IntakeEvent,
  type ProcessIntakeDeps,
} from '../intake/processIntakeEvent.js';

export interface IntakeRequestLike {
  body: unknown;
}

export interface IntakeResponseLike {
  status: (code: number) => IntakeResponseLike;
  json: (payload: unknown) => void;
}

export interface IntakeRouteDeps {
  intakeDepsFor: (event: IntakeEvent) => ProcessIntakeDeps;
}

export function createIntakeHandler(deps: IntakeRouteDeps) {
  return async function intakeHandler(
    req: IntakeRequestLike,
    res: IntakeResponseLike,
  ): Promise<void> {
    const parsed = parseIntakeBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, failing_fields: parsed.failing_fields });
      return;
    }
    const event: IntakeEvent = parsed.event;
    const result = await processIntakeEvent(event, deps.intakeDepsFor(event));
    if (!result.ok) {
      res.status(500).json({ ok: false, intake_event_id: event.intake_event_id, error: result.error });
      return;
    }
    res.status(200).json({
      ok: true,
      intake_event_id: event.intake_event_id,
      outcome: result.outcome,
    });
  };
}
