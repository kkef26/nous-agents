import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIntakeBody, INTAKE_SCHEMA_VERSION, MECHANICAL_FAILURE_CLASSES } from '../../src/contract/intakeContract.js';

test('accepts the exact payload conductor sends today', () => {
  const conductorPayload = {
    clause_id: 'BRO.1',
    dispatch_id: 'f894fce7-6b53-4010-a0d7-5f1613866fd5',
    project: 'bro',
    failure_class: 'branch_not_found',
    timestamp: new Date().toISOString(),
    detail: { repo: 'kkef26/bro', branch: 'dispatch/BRO.1' },
  };
  const r = parseIntakeBody(conductorPayload);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.event.project, 'bro');
    assert.equal(r.event.failure_class, 'branch_not_found');
    assert.equal(r.event.clause_id, 'BRO.1');
    assert.equal(r.event.source, 'push');
    assert.ok(r.event.intake_event_id.length > 0, 'server generates intake_event_id');
  }
});

test('rejects payloads missing project or failure_class with field detail', () => {
  const r = parseIntakeBody({ clause_id: 'X.1' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    const paths = r.failing_fields.map((f) => f.path).sort();
    assert.deepEqual(paths, ['failure_class', 'project']);
  }
});

test('preserves caller intake_event_id and detail', () => {
  const r = parseIntakeBody({
    intake_event_id: 'evt-1',
    project: 'nous',
    failure_class: 'stale_verifying',
    source: 'poll',
    detail: { a: 1 },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.event.intake_event_id, 'evt-1');
    assert.equal(r.event.source, 'poll');
    assert.deepEqual(r.event.raw.detail, { a: 1 });
  }
});

test('schema version and mechanical class vocabulary are exported', () => {
  assert.equal(INTAKE_SCHEMA_VERSION, 2);
  assert.ok(MECHANICAL_FAILURE_CLASSES.has('branch_not_found'));
  assert.ok(!MECHANICAL_FAILURE_CLASSES.has('merge_conflict'));
});
