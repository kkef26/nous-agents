/**
 * HTTP /intake route — receives push events from Conductor and Scoper.
 *
 * The handler is a thin shell: parse and validate the payload, then
 * delegate to processIntakeEvent. The shared function is the same one
 * the poller calls, ensuring identical friction and fix-registry
 * records regardless of delivery path.
 */

import { processIntakeEvent, type IntakeEvent, type ProcessIntakeDeps } from '../intake/processIntakeEvent.js';

export interface IntakeRequestLike {
  body: unknown;
}

export interface IntakeResponseLike {
  status: (code: number) => IntakeResponseLike;
  json: (payload: unknown) => void;
}

export interface IntakeRouteDeps {
  intake: ProcessIntakeDeps;
}

export function createIntakeHandler(deps: IntakeRouteDeps) {
  return async function intakeHandler(req: IntakeRequestLike, res: IntakeResponseLike): Promise<void> {
    const parsed = parseIntakePayload(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await processIntakeEvent(parsed.event, deps.intake);
    if (!result.ok) {
      res.status(500).json({ ok: false, error: result.error });
      return;
    }
    res.status(200).json({ ok: true, outcome: result.outcome });
  };
}

interface ParseOk {
  ok: true;
  event: IntakeEvent;
}

interface ParseErr {
  ok: false;
  error: string;
}

function parseIntakePayload(body: unknown): ParseOk | ParseErr {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.intake_event_id !== 'string') {
    return { ok: false, error: 'intake_event_id is required' };
  }
  if (typeof b.project !== 'string') {
    return { ok: false, error: 'project is required' };
  }
  if (typeof b.failure_class !== 'string') {
    return { ok: false, error: 'failure_class is required' };
  }
  return {
    ok: true,
    event: {
      intake_event_id: b.intake_event_id,
      source: 'push',
      dispatch_id: typeof b.dispatch_id === 'string' ? b.dispatch_id : null,
      clause_id: typeof b.clause_id === 'string' ? b.clause_id : null,
      run_id: typeof b.run_id === 'string' ? b.run_id : null,
      project: b.project,
      failure_class: b.failure_class,
      raw: (b.raw as Record<string, unknown>) ?? {},
    },
  };
}
