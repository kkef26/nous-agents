/**
 * processIntakeEvent — the single shared function called by both the
 * HTTP /intake route and the poller. Pulling the work out of the route
 * handler is what lets the poller exercise the exact same code path
 * without making an outbound HTTP call to localhost (per clause D9).
 *
 * The function is intentionally side-effect-heavy but exception-safe:
 * the remediation loop already catches its own failures, friction
 * writes are non-fatal, and any unhandled error here is caught and
 * returned as { ok: false } so callers can decide what to do with it.
 */

import { runRemediationLoop, type RemediationContext, type RemediationDeps, type RemediationOutcome } from '../conductor/remediationLoop.js';

export interface IntakeEvent {
  intake_event_id: string;
  source: 'push' | 'poll';
  dispatch_id: string | null;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  failure_class: string;
  raw: Record<string, unknown>;
}

export interface ProcessIntakeResult {
  ok: boolean;
  outcome: RemediationOutcome | null;
  error?: string;
}

export interface ProcessIntakeDeps {
  remediation: RemediationDeps;
  agent_id: string;
}

export async function processIntakeEvent(
  event: IntakeEvent,
  deps: ProcessIntakeDeps,
): Promise<ProcessIntakeResult> {
  const context: RemediationContext = {
    intake_event_id: event.intake_event_id,
    clause_id: event.clause_id,
    run_id: event.run_id,
    project: event.project,
    dispatch_id: event.dispatch_id,
    agent_id: deps.agent_id,
    failure_class: event.failure_class,
  };
  try {
    const outcome = await runRemediationLoop(context, deps.remediation);
    return { ok: true, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[macgruber] processIntakeEvent failed for intake=${event.intake_event_id}: ${message}\n`,
    );
    return { ok: false, outcome: null, error: message };
  }
}
