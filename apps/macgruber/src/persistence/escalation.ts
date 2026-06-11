/**
 * Hard-escalation to nous.decision_queue.
 *
 * Called only when the circuit breaker has exhausted its retry budget for a
 * given (clause_id, failure_class). Writes a single decision_queue row whose
 * `context` jsonb carries the full investigation report — including the
 * intake_event_id traceability anchor — so a human reviewer can reconstruct
 * what was tried and why it failed.
 *
 * Constraints honoured:
 *  - never write to decision_queue while retry budget remains (callers gate)
 *  - intake_event_id must always be present in payload.context
 *  - all SQL is parameterised; no string concatenation
 */

import type { ParamQueryClient } from '../lib/db.js';
import type { CircuitBreakerSnapshot, DecisionQueuePayload, InvestigationReport } from '../types/friction.js';

export interface EscalationResult {
  ok: boolean;
  decision_id: string | null;
  error?: string;
}

const INSERT_DECISION_SQL = `
  INSERT INTO nous.decision_queue (
    dispatch_id,
    agent_id,
    project,
    bible_clause,
    question,
    context,
    urgency,
    status,
    auto_answer_rule,
    error_summary,
    escalated_at,
    created_at,
    updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, now(), now(), now())
  RETURNING id
`;

export interface WriteDecisionQueueInput {
  payload: DecisionQueuePayload;
  breaker: CircuitBreakerSnapshot;
  agent_id?: string;
  auto_answer_rule?: string | null;
}

export async function writeDecisionQueueEntry(
  client: ParamQueryClient,
  input: WriteDecisionQueueInput,
): Promise<EscalationResult> {
  const { payload, breaker } = input;
  if (!breaker.exhausted) {
    return { ok: false, decision_id: null, error: 'circuit breaker not exhausted; refusing to escalate' };
  }
  const intakeId = payload.context.intake_event_id;
  if (!intakeId) {
    return { ok: false, decision_id: null, error: 'intake_event_id missing from payload.context' };
  }
  const errorSummary = `circuit_breaker_exhausted:${breaker.failure_class}:${breaker.attempts}/${breaker.max_attempts}`;
  const insertOnce = async (dispatchId: string | null): Promise<EscalationResult> => {
    const { rows } = await client.query<{ id: string }>(INSERT_DECISION_SQL, [
      dispatchId,
      input.agent_id ?? payload.agent_id,
      payload.project,
      payload.bible_clause,
      payload.question,
      JSON.stringify(payload.context),
      payload.urgency,
      input.auto_answer_rule ?? null,
      errorSummary,
    ]);
    if (rows.length === 0) {
      return { ok: false, decision_id: null, error: 'decision_queue insert returned no rows' };
    }
    return { ok: true, decision_id: rows[0].id };
  };
  try {
    try {
      return await insertOnce(payload.dispatch_id);
    } catch (err) {
      // The dispatch row may have been deleted (supersede sweep) or the id may
      // be synthetic (poller). The escalation must still land — retry without
      // the FK linkage; the full context jsonb keeps the dispatch_id.
      const msg = err instanceof Error ? err.message : String(err);
      if (payload.dispatch_id && msg.includes('decision_queue_dispatch_id_fkey')) {
        return await insertOnce(null);
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[macgruber] decision_queue insert failed: ${message}\n`);
    return { ok: false, decision_id: null, error: message };
  }
}

export function buildInvestigationPayload(input: {
  report: InvestigationReport;
  agent_id: string;
  dispatch_id: string | null;
  urgency?: 'blocking' | 'advisory';
}): DecisionQueuePayload {
  return {
    dispatch_id: input.dispatch_id,
    agent_id: input.agent_id,
    project: input.report.project,
    bible_clause: input.report.clause_id,
    question: `macgruber circuit breaker exhausted for failure_class=${input.report.failure_class}. Manual review required.`,
    context: input.report,
    urgency: input.urgency ?? 'blocking',
  };
}
