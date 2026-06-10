/**
 * Remediation loop — orchestrates the per-failure remediation pipeline.
 *
 * For each attempt:
 *   1. Run the fix strategy through the router (FEAT.MACGRUBER.6).
 *   2. Write a friction entry capturing root cause + outcome. Friction
 *      writes are non-fatal: a DB error logs to stderr but the loop
 *      continues.
 *   3. If the attempt resolved the failure, exit success.
 *   4. Otherwise, check the circuit breaker. If retry budget remains,
 *      sleep briefly and try again.
 *   5. When the breaker exhausts, build an InvestigationReport and write
 *      a single decision_queue row. Stop retrying.
 */

import { routeFixStrategy, type FixStrategy, type RoutingReport } from '../router/failureClassRouter.js';
import type { ExecuteActionDeps } from '../executors/executeAction.js';
import { upsertFriction, type WriteFrictionResult } from '../persistence/friction.js';
import { buildInvestigationPayload, writeDecisionQueueEntry } from '../persistence/escalation.js';
import type { ParamQueryClient } from '../lib/db.js';
import type { CircuitBreakerSnapshot, InvestigationReport } from '../types/friction.js';

export interface RemediationContext {
  intake_event_id: string;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  dispatch_id: string | null;
  agent_id: string;
}

export interface RemediationDeps {
  executor: ExecuteActionDeps;
  db: ParamQueryClient;
  maxAttempts: number;
  produceFixStrategy: (
    context: RemediationContext,
    history: RoutingReport[],
  ) => Promise<FixStrategy>;
  attemptResolved: (report: RoutingReport) => boolean;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  delayBetweenAttemptsMs?: number;
}

export interface RemediationOutcome {
  resolved: boolean;
  attempts: number;
  reports: RoutingReport[];
  friction: WriteFrictionResult | null;
  escalated: boolean;
  decision_id: string | null;
}

export async function runRemediationLoop(
  context: RemediationContext,
  deps: RemediationDeps,
): Promise<RemediationOutcome> {
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const delay = deps.delayBetweenAttemptsMs ?? 500;
  const reports: RoutingReport[] = [];
  const fixRegistryIds: string[] = [];
  const attempts: InvestigationReport['attempts'] = [];
  let lastFriction: WriteFrictionResult | null = null;

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const startedAt = clock().toISOString();
    const strategy = await deps.produceFixStrategy(context, reports);
    const report = await routeFixStrategy(strategy, deps.executor);
    reports.push(report);
    const completedAt = clock().toISOString();
    const resolved = deps.attemptResolved(report);
    attempts.push({
      attempt,
      started_at: startedAt,
      completed_at: completedAt,
      outcome: resolved ? 'success' : 'failure',
      note: report.rationale,
    });

    lastFriction = await upsertFriction(deps.db, {
      project: context.project,
      failure_class: strategy.failure_class,
      root_cause: deriveRootCause(report),
      proposed_fix: strategy.rationale,
      tags: ['macgruber', `attempt:${attempt}`],
    });

    if (resolved) {
      return {
        resolved: true,
        attempts: attempt,
        reports,
        friction: lastFriction,
        escalated: false,
        decision_id: null,
      };
    }

    const breaker: CircuitBreakerSnapshot = {
      attempts: attempt,
      max_attempts: deps.maxAttempts,
      exhausted: attempt >= deps.maxAttempts,
      failure_class: strategy.failure_class,
    };

    if (breaker.exhausted) {
      const escalation = await escalate(context, reports, attempts, breaker, fixRegistryIds, lastFriction, deps);
      return {
        resolved: false,
        attempts: attempt,
        reports,
        friction: lastFriction,
        escalated: escalation.ok,
        decision_id: escalation.decision_id,
      };
    }

    await sleep(delay);
  }

  return {
    resolved: false,
    attempts: deps.maxAttempts,
    reports,
    friction: lastFriction,
    escalated: false,
    decision_id: null,
  };
}

async function escalate(
  context: RemediationContext,
  reports: RoutingReport[],
  attempts: InvestigationReport['attempts'],
  breaker: CircuitBreakerSnapshot,
  fixRegistryIds: string[],
  friction: WriteFrictionResult | null,
  deps: RemediationDeps,
): Promise<{ ok: boolean; decision_id: string | null }> {
  const last = reports[reports.length - 1];
  const report: InvestigationReport = {
    intake_event_id: context.intake_event_id,
    clause_id: context.clause_id,
    run_id: context.run_id,
    project: context.project,
    failure_class: breaker.failure_class,
    root_cause: last ? deriveRootCause(last) : 'unknown',
    proposed_fix: last?.rationale ?? 'unknown',
    attempts,
    fix_registry_ids: fixRegistryIds,
    friction_id: friction?.friction_id ?? null,
  };
  const payload = buildInvestigationPayload({
    report,
    agent_id: context.agent_id,
    dispatch_id: context.dispatch_id,
  });
  const result = await writeDecisionQueueEntry(deps.db, { payload, breaker });
  return { ok: result.ok, decision_id: result.decision_id };
}

function deriveRootCause(report: RoutingReport): string {
  const firstFailure = report.results.find((r) => !r.result.success);
  if (firstFailure && !firstFailure.result.success) {
    return `${firstFailure.action.kind}:${firstFailure.result.error_class}:${firstFailure.result.message}`;
  }
  return `${report.failure_class}:no-failed-action`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
