import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MACGRUBER_CATEGORY,
  MACGRUBER_REPORTED_BY,
  upsertFriction,
  writeFriction,
} from '../../src/persistence/friction.js';
import type { ParamQueryClient } from '../../src/lib/db.js';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

function mockClient(
  responses: Array<{ rows: unknown[] } | Error>,
): { client: ParamQueryClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const client: ParamQueryClient = {
    async query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ sql, params });
      const next = responses[i++];
      if (next instanceof Error) throw next;
      if (!next) throw new Error(`mock client exhausted at call ${i}`);
      return { rows: next.rows as R[] };
    },
  };
  return { client, calls };
}

test('upsertFriction inserts a new row when no match exists', async () => {
  const { client, calls } = mockClient([
    { rows: [] }, // SELECT existing
    { rows: [{ id: 'frict-1', recurrence_count: 1 }] }, // INSERT
  ]);
  const result = await upsertFriction(client, {
    project: 'nous-agents',
    failure_class: 'compile_error',
    root_cause: 'missing import',
    proposed_fix: 'add import',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, true);
  assert.equal(result.friction_id, 'frict-1');
  assert.equal(result.recurrence_count, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /FROM nous\.friction/);
  assert.deepEqual(calls[0].params, [
    'nous-agents',
    MACGRUBER_REPORTED_BY,
    MACGRUBER_CATEGORY,
    'class:compile_error',
  ]);
  assert.match(calls[1].sql, /INSERT INTO nous\.friction/);
  const insertParams = calls[1].params;
  assert.equal(insertParams[0], 'nous-agents');
  assert.equal(insertParams[1], MACGRUBER_CATEGORY);
  assert.equal(insertParams[2], MACGRUBER_REPORTED_BY);
  assert.equal(insertParams[3], 'missing import');
  assert.equal(insertParams[4], 'add import');
});

test('upsertFriction increments recurrence_count when a row already exists', async () => {
  const { client, calls } = mockClient([
    { rows: [{ id: 'frict-existing', recurrence_count: 3 }] },
    { rows: [{ id: 'frict-existing', recurrence_count: 4 }] },
  ]);
  const result = await upsertFriction(client, {
    project: 'nous-agents',
    failure_class: 'merge_conflict',
    root_cause: 'concurrent worker',
    proposed_fix: 'serialise dispatches',
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, false);
  assert.equal(result.friction_id, 'frict-existing');
  assert.equal(result.recurrence_count, 4);
  assert.match(calls[1].sql, /UPDATE nous\.friction/);
  assert.equal(calls[1].params[0], 'frict-existing');
});

test('upsertFriction never throws when the DB call fails', async () => {
  const { client } = mockClient([new Error('connection refused')]);
  const result = await upsertFriction(client, {
    project: 'nous-agents',
    failure_class: 'deploy_timeout',
    root_cause: 'edge function cold start',
    proposed_fix: 'pre-warm',
  });
  assert.equal(result.ok, false);
  assert.equal(result.friction_id, null);
  assert.equal(result.error, 'connection refused');
});

test('writeFriction is an alias for upsertFriction', async () => {
  const { client } = mockClient([
    { rows: [] },
    { rows: [{ id: 'frict-2', recurrence_count: 1 }] },
  ]);
  const result = await writeFriction(client, {
    project: 'p',
    failure_class: 'test_failure',
    root_cause: 'flake',
    proposed_fix: 'retry',
  });
  assert.equal(result.ok, true);
  assert.equal(result.friction_id, 'frict-2');
});
