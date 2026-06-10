/**
 * Conductor verdict router — modification surface per FEAT.MACGRUBER.8.
 *
 * This file documents the contract for where `notifyMacGruber` should fire.
 * The full Conductor v2 verdict logic lives in `supabase/functions/conductor/`;
 * this module is the import surface for the MacGruber client and a thin
 * helper that callers can use to express the verdict-to-intake mapping.
 */

import { notifyMacGruber, type MacGruberPushPayload } from './macgruberClient.js';

export type ConductorVerdict =
  | 'pass'
  | 'pass_with_amendments'
  | 'fail_tactical'
  | 'fail_strategic';

export interface VerdictContext {
  verdict: ConductorVerdict;
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

/**
 * Fire-and-forget hand-off from the verdict path to MacGruber.
 * Returns immediately; the push runs in the background and never throws.
 */
export function maybeNotifyOnVerdict(ctx: VerdictContext): void {
  if (ctx.verdict !== 'fail_tactical' && ctx.verdict !== 'fail_strategic') return;

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
