/**
 * failureClassRouter — bridges a sonnet-produced fix strategy to the executor
 * layer. After the LLM returns a list of FixAction items, each is dispatched
 * through executeAction in order and the outcomes are returned in a structured
 * routing report. Order matters: early failures may make later actions moot,
 * but per D10 the loop never rewrites the plan mid-flight — that decision is
 * made by the calling remediation loop after this function returns.
 */

import { executeAction, type ExecuteActionDeps } from '../executors/executeAction.js';
import type { ActionResult, FixAction } from '../executors/types.js';

import type { FailureClass } from '../contract/intakeContract.js';

export type { FailureClass };

export interface FixStrategy {
  failure_class: FailureClass;
  actions: FixAction[];
  rationale: string;
}

export interface RoutingReport {
  failure_class: FailureClass;
  results: Array<{ action: FixAction; result: ActionResult }>;
  attempted: number;
  succeeded: number;
  failed: number;
  rationale: string;
}

export async function routeFixStrategy(
  strategy: FixStrategy,
  deps: ExecuteActionDeps,
): Promise<RoutingReport> {
  const results: Array<{ action: FixAction; result: ActionResult }> = [];
  for (const action of strategy.actions) {
    const result = await executeAction(action, deps);
    results.push({ action, result });
  }
  const succeeded = results.filter((r) => r.result.success).length;
  return {
    failure_class: strategy.failure_class,
    results,
    attempted: results.length,
    succeeded,
    failed: results.length - succeeded,
    rationale: strategy.rationale,
  };
}
