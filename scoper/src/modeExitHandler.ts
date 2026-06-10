/**
 * Scoper mode exit handler — modification surface per FEAT.MACGRUBER.8.
 *
 * Scoper has three outcome modes (per the grill decisions):
 *  - Mode A: clean, emit dispatch_tree (no MacGruber push needed)
 *  - Mode B: gaps_hold via scoper_findings (push to MacGruber)
 *  - Mode C: structural_block via decision_queue (push to MacGruber)
 *
 * This handler is the entry point for Mode B/C exits. The Scoper main loop
 * (`scoper/src/plan.ts`, `scoper/src/replan.ts`) imports `handleFailureExit`
 * and calls it just before returning the mode verdict.
 */

import { notifyMacGruber, type MacGruberPushPayload } from './macgruberClient.js';

export type ScoperOutcomeMode = 'A' | 'B' | 'C';

export interface ModeExitContext {
  mode: ScoperOutcomeMode;
  failure_class: string;
  error_message: string;
  step_attempted: string;
  repo: string;
  branch: string;
  sha: string;
  clause_id: string;
  prior_attempts: number;
  dispatch_event_id: string;
  agent_id: string;
  stack_trace?: string;
}

export function handleFailureExit(ctx: ModeExitContext): void {
  if (ctx.mode === 'A') return;

  const payload: Omit<MacGruberPushPayload, 'reported_by'> = {
    failure_class: ctx.failure_class,
    error_message: ctx.error_message,
    step_attempted: ctx.step_attempted,
    repo: ctx.repo,
    branch: ctx.branch,
    sha: ctx.sha,
    clause_id: ctx.clause_id,
    prior_attempts: ctx.prior_attempts,
    dispatch_event_id: ctx.dispatch_event_id,
    agent_id: ctx.agent_id,
    timestamp: new Date().toISOString(),
    ...(ctx.stack_trace ? { stack_trace: ctx.stack_trace } : {}),
  };

  void notifyMacGruber(payload).catch(() => {
    /* notifyMacGruber already swallows; this is belt-and-braces. */
  });
}
