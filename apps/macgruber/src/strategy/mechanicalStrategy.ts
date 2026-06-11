/**
 * Mechanical fix strategies — deterministic remediation for infra-class
 * failures. No LLM: a dead branch or a stalled worker has exactly one sane
 * fix (cancel the dead row, retrigger the tree). Anything that needs
 * judgement (merge_conflict, gate_failure, unknown) escalates to
 * nous.decision_queue via the remediation loop's circuit breaker.
 */

import type { RemediationContext } from '../conductor/remediationLoop.js';
import type { FixStrategy } from '../router/failureClassRouter.js';
import type { RoutingReport } from '../router/failureClassRouter.js';
import type { FixAction } from '../executors/types.js';
import type { ParamQueryClient } from '../lib/db.js';
import { MECHANICAL_FAILURE_CLASSES } from '../contract/intakeContract.js';

export const NOOP_PREFIX = 'noop:';
export const ESCALATE_PREFIX = 'escalate:';

/** Statuses where cancelling would be wrong or meaningless. */
const NO_CANCEL_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'complete',
  'reconciled',
  'knowledge_complete',
]);

interface DispatchLookupRow {
  id: string;
  status: string;
  tree_run_id: string | null;
  clause_id: string | null;
  clause_status: string | null;
  maturity_stage: string | null;
}

const LOOKUP_SQL = `
  SELECT dq.id::text AS id,
         dq.status,
         dq.tree_run_id::text AS tree_run_id,
         COALESCE(dq.clause_id, dq.bible_clause) AS clause_id,
         bc.status AS clause_status,
         bc.maturity_stage
  FROM nous.dispatch_queue dq
  LEFT JOIN nous.bible_clauses bc
    ON bc.id = COALESCE(dq.clause_id, dq.bible_clause)
  WHERE dq.id = $1::uuid
  LIMIT 1
`;

async function lookupDispatch(
  db: ParamQueryClient,
  dispatchId: string,
): Promise<DispatchLookupRow | null> {
  const { rows } = await db.query<DispatchLookupRow>(LOOKUP_SQL, [dispatchId]);
  return rows[0] ?? null;
}

function clauseShipped(row: DispatchLookupRow): boolean {
  return (
    row.clause_status === 'shipped' ||
    row.clause_status === 'retired' ||
    row.clause_status === 'deprecated' ||
    row.maturity_stage === 'SHIPPED'
  );
}

function noop(failureClass: string, why: string): FixStrategy {
  return { failure_class: failureClass, actions: [], rationale: `${NOOP_PREFIX} ${why}` };
}

function escalate(failureClass: string, why: string): FixStrategy {
  return { failure_class: failureClass, actions: [], rationale: `${ESCALATE_PREFIX} ${why}` };
}

/**
 * Attempt resolution semantics shared by server and poller:
 *  - a noop strategy is resolved by definition (nothing to fix),
 *  - otherwise at least one action must have run and none failed.
 */
export function attemptResolved(report: RoutingReport): boolean {
  if (report.rationale.startsWith(NOOP_PREFIX)) return true;
  return report.attempted > 0 && report.failed === 0;
}

/**
 * Build the produceFixStrategy dependency for the remediation loop.
 * One mechanical attempt per intake: if the first attempt failed, the
 * second call escalates rather than blindly repeating side effects.
 */
export function createMechanicalStrategy(
  db: ParamQueryClient,
): (context: RemediationContext, history: RoutingReport[]) => Promise<FixStrategy> {
  return async function produceFixStrategy(context, history) {
    const failureClass = context.failure_class || 'unknown';

    if (history.length > 0) {
      return escalate(failureClass, 'mechanical attempt already failed; not repeating side effects');
    }
    if (!context.dispatch_id) {
      return escalate(failureClass, 'intake carries no dispatch_id');
    }
    const row = await lookupDispatch(db, context.dispatch_id);
    if (!row) {
      return escalate(failureClass, `no dispatch_queue row for ${context.dispatch_id}`);
    }
    if (clauseShipped(row)) {
      return noop(failureClass, `clause ${row.clause_id ?? '(unknown)'} already shipped — nothing to fix`);
    }
    if (!MECHANICAL_FAILURE_CLASSES.has(failureClass)) {
      return escalate(failureClass, `no mechanical handler for failure_class=${failureClass}`);
    }
    if (!row.tree_run_id) {
      return escalate(failureClass, 'dispatch has no tree_run_id — cannot retrigger');
    }

    const actions: FixAction[] = [];
    if (!NO_CANCEL_STATUSES.has(row.status)) {
      actions.push({
        kind: 'cancel_dispatch',
        dispatch_id: row.id,
        reason: `macgruber: ${failureClass}`,
      });
    }
    actions.push({
      kind: 'retrigger_tree',
      tree_run_id: row.tree_run_id,
      reason: `macgruber: rebuild after ${failureClass}`,
    });
    return {
      failure_class: failureClass,
      actions,
      rationale: `mechanical: cancel dead dispatch ${row.id} and retrigger tree ${row.tree_run_id} (${failureClass})`,
    };
  };
}
