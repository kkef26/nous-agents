import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMechanicalStrategy,
  attemptResolved,
  NOOP_PREFIX,
  ESCALATE_PREFIX,
} from '../../src/strategy/mechanicalStrategy.js';
import type { RemediationContext } from '../../src/conductor/remediationLoop.js';
import type { ParamQueryClient } from '../../src/lib/db.js';
import type { RoutingReport } from '../../src/router/failureClassRouter.js';

function ctx(over: Partial<RemediationContext> = {}): RemediationContext {
  return {
    intake_event_id: 'evt-1',
    clause_id: 'X.1',
    run_id: null,
    project: 'nous',
    dispatch_id: '00000000-0000-0000-0000-000000000001',
    agent_id: 'macgruber',
    failure_class: 'branch_not_found',
    ...over,
  };
}

function dbReturning(row: Record<string, unknown> | null): ParamQueryClient {
  return {
    async query<R>() {
      return { rows: (row ? [row] : []) as R[] };
    },
  };
}

const liveRow = {
  id: '00000000-0000-0000-0000-000000000001',
  status: 'failed',
  tree_run_id: '00000000-0000-0000-0000-00000000aaaa',
  clause_id: 'X.1',
  clause_status: 'active',
  maturity_stage: 'SCAFFOLD',
};

test('mechanical class with tree_run_id -> cancel + retrigger', async () => {
  const strategy = await createMechanicalStrategy(dbReturning(liveRow))(ctx(), []);
  assert.deepEqual(
    strategy.actions.map((a) => a.kind),
    ['cancel_dispatch', 'retrigger_tree'],
  );
});

test('shipped clause -> noop, and noop reports count as resolved', async () => {
  const strategy = await createMechanicalStrategy(
    dbReturning({ ...liveRow, clause_status: 'shipped' }),
  )(ctx(), []);
  assert.equal(strategy.actions.length, 0);
  assert.ok(strategy.rationale.startsWith(NOOP_PREFIX));
  const report: RoutingReport = {
    failure_class: 'branch_not_found',
    results: [],
    attempted: 0,
    succeeded: 0,
    failed: 0,
    rationale: strategy.rationale,
  };
  assert.equal(attemptResolved(report), true);
});

test('non-mechanical class -> escalate', async () => {
  const strategy = await createMechanicalStrategy(dbReturning(liveRow))(
    ctx({ failure_class: 'merge_conflict' }),
    [],
  );
  assert.equal(strategy.actions.length, 0);
  assert.ok(strategy.rationale.startsWith(ESCALATE_PREFIX));
});

test('missing dispatch row / tree_run_id -> escalate', async () => {
  const noRow = await createMechanicalStrategy(dbReturning(null))(ctx(), []);
  assert.ok(noRow.rationale.startsWith(ESCALATE_PREFIX));
  const noTree = await createMechanicalStrategy(
    dbReturning({ ...liveRow, tree_run_id: null }),
  )(ctx(), []);
  assert.ok(noTree.rationale.startsWith(ESCALATE_PREFIX));
});

test('second attempt after failure escalates instead of repeating side effects', async () => {
  const failedReport: RoutingReport = {
    failure_class: 'branch_not_found',
    results: [],
    attempted: 2,
    succeeded: 1,
    failed: 1,
    rationale: 'mechanical: ...',
  };
  const strategy = await createMechanicalStrategy(dbReturning(liveRow))(ctx(), [failedReport]);
  assert.ok(strategy.rationale.startsWith(ESCALATE_PREFIX));
  assert.equal(attemptResolved(failedReport), false);
});
