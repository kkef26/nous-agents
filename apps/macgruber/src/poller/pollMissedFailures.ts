/**
 * pollMissedFailures — PM2 cron entry point.
 *
 * Discovers failures that never reached MacGruber via the push path,
 * routes them through processIntakeEvent (NOT via HTTP loopback), and
 * exits with a status code that PM2 can use to detect catastrophic
 * failure. The poller runs as a fully independent PM2 process: a crash
 * here MUST NOT affect the API server.
 *
 * Per clause constraint: any DB error inside the poller is caught and
 * triggers exit(1). The API process is unaffected.
 */

import { processIntakeEvent, type IntakeEvent, type ProcessIntakeDeps } from '../intake/processIntakeEvent.js';
import { queryUnhandledFailures, type UnhandledFailure } from './queryUnhandled.js';
import type { ParamQueryClient } from '../lib/db.js';

export interface PollerDeps {
  db: ParamQueryClient;
  intake: ProcessIntakeDeps;
  options?: {
    limit?: number;
    lookbackMinutes?: number;
    project?: string;
  };
  log?: (message: string) => void;
}

export interface PollerSummary {
  found: number;
  processed: number;
  failed: number;
  exitCode: 0 | 1;
  error?: string;
}

export async function pollMissedFailures(deps: PollerDeps): Promise<PollerSummary> {
  const log = deps.log ?? defaultLog;
  let failures: UnhandledFailure[] = [];
  try {
    failures = await queryUnhandledFailures(deps.db, deps.options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[macgruber-poller] query failed: ${message}`);
    return { found: 0, processed: 0, failed: 0, exitCode: 1, error: message };
  }

  if (failures.length === 0) {
    log('[macgruber-poller] no unhandled failures');
    return { found: 0, processed: 0, failed: 0, exitCode: 0 };
  }

  let processed = 0;
  let failed = 0;
  for (const failure of failures) {
    const event = toIntakeEvent(failure);
    try {
      const result = await processIntakeEvent(event, deps.intake);
      if (result.ok) processed++;
      else failed++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      log(`[macgruber-poller] intake failed for ${failure.intake_event_id}: ${message}`);
    }
  }
  log(`[macgruber-poller] found=${failures.length} processed=${processed} failed=${failed}`);
  return { found: failures.length, processed, failed, exitCode: 0 };
}

function toIntakeEvent(failure: UnhandledFailure): IntakeEvent {
  return {
    intake_event_id: failure.intake_event_id,
    source: 'poll',
    dispatch_id: failure.dispatch_id,
    clause_id: failure.clause_id,
    run_id: failure.run_id,
    project: failure.project,
    failure_class: failure.failure_class,
    raw: failure.detail ?? {},
  };
}

function defaultLog(message: string): void {
  process.stdout.write(message + '\n');
}
