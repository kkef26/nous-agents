import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInvestigationPayload,
  writeDecisionQueueEntry,
} from '../../src/persistence/escalation.js';
import type { ParamQueryClient } from '../../src/lib/db.js';
import type { CircuitBreakerSnapshot, InvestigationReport } from '../../src/types/friction.js';

function mockClient(
  responses: Array<{ rows: unknown[] } | Error>,
): { client: ParamQueryClient; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const client: ParamQueryClient = {
    async query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ sql, params });
      const next = responses[i++];
      if (next instanceof Error) throw next;
      if (!next) throw new Error('mock exhausted');
      return { rows: next.rows as R[] };
    },
  };
  return { client, calls };
}

function sampleReport(): InvestigationReport {
  return {
    intake_event_id: 'intake-1',
    clause_id: 'FEAT.MACGRUBER.6',
    run_id: 'run-1',
    project: 'nous-agents',
    failure_class: 'compile_error',
    root_cause: 'missing import in src/foo.ts',
    proposed_fix: 'add the import',
    attempts: [
      { attempt: 1, started_at: '2026-06-10T00:00:00Z', completed_at: '2026-06-10T00:00:01Z', outcome: 'failure', note: 'r1' },
      { attempt: 2, started_at: '2026-06-10T00:00:02Z', completed_at: '2026-06-10T00:00:03Z', outcome: 'failure', note: 'r2' },
    ],
    fix_registry_ids: ['fix-a', 'fix-b'],
    friction_id: 'frict-1',
  };
}

function exhausted(failureClass: string): CircuitBreakerSnapshot {
  return { attempts: 2, max_attempts: 2, exhausted: true, failure_class: failureClass };
}

test('buildInvestigationPayload preserves intake_event_id and clause linkage', () => {
  const report = sampleReport();
  const payload = buildInvestigationPayload({
    report,
    agent_id: 'macgruber-svc',
    dispatch_id: 'disp-1',
  });
  assert.equal(payload.context.intake_event_id, 'intake-1');
  assert.equal(payload.bible_clause, 'FEAT.MACGRUBER.6');
  assert.equal(payload.urgency, 'blocking');
  assert.equal(payload.agent_id, 'macgruber-svc');
  assert.equal(payload.dispatch_id, 'disp-1');
});

test('writeDecisionQueueEntry inserts a row with the full report in context', async () => {
  const { client, calls } = mockClient([{ rows: [{ id: 'dq-1' }] }]);
  const payload = buildInvestigationPayload({
    report: sampleReport(),
    agent_id: 'macgruber-svc',
    dispatch_id: 'disp-1',
  });
  const result = await writeDecisionQueueEntry(client, {
    payload,
    breaker: exhausted('compile_error'),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision_id, 'dq-1');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO nous\.decision_queue/);
  const params = calls[0].params;
  assert.equal(params[0], 'disp-1');
  assert.equal(params[1], 'macgruber-svc');
  assert.equal(params[3], 'FEAT.MACGRUBER.6');
  const contextJson = JSON.parse(params[5] as string) as InvestigationReport;
  assert.equal(contextJson.intake_event_id, 'intake-1');
  assert.equal(params[6], 'blocking');
  assert.match(params[8] as string, /^circuit_breaker_exhausted:compile_error:2\/2$/);
});

test('writeDecisionQueueEntry refuses to escalate while retry budget remains', async () => {
  const { client, calls } = mockClient([]);
  const payload = buildInvestigationPayload({
    report: sampleReport(),
    agent_id: 'macgruber-svc',
    dispatch_id: null,
  });
  const result = await writeDecisionQueueEntry(client, {
    payload,
    breaker: { attempts: 1, max_attempts: 2, exhausted: false, failure_class: 'compile_error' },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.match(result.error ?? '', /circuit breaker not exhausted/);
});

test('writeDecisionQueueEntry rejects payloads without intake_event_id', async () => {
  const { client, calls } = mockClient([]);
  const report = sampleReport();
  // Force-clear intake_event_id without changing the FrictionInput type.
  const payload = buildInvestigationPayload({
    report,
    agent_id: 'macgruber-svc',
    dispatch_id: null,
  });
  (payload.context as { intake_event_id: string }).intake_event_id = '';
  const result = await writeDecisionQueueEntry(client, {
    payload,
    breaker: exhausted('compile_error'),
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.match(result.error ?? '', /intake_event_id missing/);
});
