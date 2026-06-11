import test from 'node:test';
import assert from 'node:assert/strict';

import { pollMissedFailures, type PollerDeps } from '../../src/poller/pollMissedFailures.js';
import type { ParamQueryClient } from '../../src/lib/db.js';
import type { UnhandledFailure } from '../../src/poller/queryUnhandled.js';
import type { ProcessIntakeDeps } from '../../src/intake/processIntakeEvent.js';
import type { RemediationDeps } from '../../src/conductor/remediationLoop.js';

function buildIntakeDeps(): ProcessIntakeDeps {
  const remediation: RemediationDeps = {
    executor: undefined as never,
    db: { async query() { return { rows: [] }; } },
    maxAttempts: 2,
    produceFixStrategy: async () => ({
      failure_class: 'unknown',
      actions: [],
      rationale: 'noop',
    }),
    attemptResolved: () => true,
  };
  return { remediation, agent_id: 'macgruber-test' };
}

function mockQueryClient(
  unhandled: UnhandledFailure[] | Error,
): ParamQueryClient {
  return {
    async query<R>(_sql: string, _params: unknown[]): Promise<{ rows: R[] }> {
      if (unhandled instanceof Error) throw unhandled;
      return { rows: unhandled as R[] };
    },
  };
}

test('pollMissedFailures returns zero counts when no unhandled failures exist', async () => {
  const deps: PollerDeps = {
    db: mockQueryClient([]),
    intakeDepsFor: () => buildIntakeDeps(),
    log: () => {},
  };
  const summary = await pollMissedFailures(deps);
  assert.equal(summary.found, 0);
  assert.equal(summary.processed, 0);
  assert.equal(summary.exitCode, 0);
});

test('pollMissedFailures processes each unhandled failure via processIntakeEvent', async () => {
  const failures: UnhandledFailure[] = [
    {
      source: 'dispatch_events',
      intake_event_id: 'evt-1',
      dispatch_id: 'disp-1',
      clause_id: 'FEAT.MACGRUBER.9',
      run_id: 'disp-1',
      project: 'nous-agents',
      failure_class: 'compile_error',
      detected_at: '2026-06-10T00:00:00Z',
      detail: { reason: 'tsc failed' },
    },
  ];
  const intakeCalls: string[] = [];
  const intake = buildIntakeDeps();
  intake.remediation = {
    ...intake.remediation,
    produceFixStrategy: async (ctx) => {
      intakeCalls.push(ctx.intake_event_id);
      return { failure_class: 'compile_error', actions: [], rationale: 'noop' };
    },
  };
  const deps: PollerDeps = {
    db: mockQueryClient(failures),
    intakeDepsFor: () => intake,
    log: () => {},
  };
  const summary = await pollMissedFailures(deps);
  assert.equal(summary.found, 1);
  assert.equal(summary.processed, 1);
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(intakeCalls, ['evt-1']);
});

test('pollMissedFailures exits with code 1 when the DB query throws', async () => {
  const deps: PollerDeps = {
    db: mockQueryClient(new Error('connection lost')),
    intakeDepsFor: () => buildIntakeDeps(),
    log: () => {},
  };
  const summary = await pollMissedFailures(deps);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.found, 0);
  assert.match(summary.error ?? '', /connection lost/);
});

test('pollMissedFailures dedup-skip happens at the SQL boundary, not in JS', async () => {
  // The poller's contract is that any row returned by queryUnhandledFailures
  // is, by definition, missing from fix_registry. If a row is in fix_registry,
  // the LATERAL anti-join filters it out, so processIntakeEvent is never
  // called for it. We assert this by confirming the poller calls intake
  // exactly once per returned row, with no internal filtering.
  const failures: UnhandledFailure[] = [
    {
      source: 'dispatch_queue',
      intake_event_id: 'q-1',
      dispatch_id: 'q-1',
      clause_id: null,
      run_id: 'q-1',
      project: 'nous-agents',
      failure_class: 'merge_conflict',
      detected_at: '2026-06-10T00:00:00Z',
      detail: null,
    },
    {
      source: 'dispatch_queue',
      intake_event_id: 'q-2',
      dispatch_id: 'q-2',
      clause_id: null,
      run_id: 'q-2',
      project: 'nous-agents',
      failure_class: 'merge_conflict',
      detected_at: '2026-06-10T00:00:01Z',
      detail: null,
    },
  ];
  const seen: string[] = [];
  const intake = buildIntakeDeps();
  intake.remediation = {
    ...intake.remediation,
    produceFixStrategy: async (ctx) => {
      seen.push(ctx.intake_event_id);
      return { failure_class: 'merge_conflict', actions: [], rationale: 'noop' };
    },
  };
  const deps: PollerDeps = {
    db: mockQueryClient(failures),
    intakeDepsFor: () => intake,
    log: () => {},
  };
  const summary = await pollMissedFailures(deps);
  assert.equal(summary.processed, 2);
  assert.deepEqual(seen, ['q-1', 'q-2']);
});
