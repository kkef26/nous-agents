/**
 * Circuit breaker — caps remediation attempts so a flapping clause cannot
 * make MacGruber thrash the pipeline.
 *
 * Backed by nous.macgruber_intake_log (created 2026-06-11), which doubles as
 * the intake audit trail. The legacy service counted against
 * nous.circuit_breaker_log — a table that was never created in prod, so the
 * legacy breaker 500'd on every request. The intake log is written on every
 * accepted intake, so counting it IS counting attempts.
 */

import type { ParamQueryClient } from '../lib/db.js';

export const PER_PAIR_CAP = 3;
export const PAIR_WINDOW_HOURS = 24;
export const GLOBAL_WINDOW_MINUTES = 60;
export const GLOBAL_WINDOW_CAP = 20;

export interface BreakerVerdict {
  allowed: boolean;
  reason: 'ok' | 'per_pair_cap' | 'global_window_cap';
  pair_count: number;
  global_count: number;
}

export async function checkBreaker(
  db: ParamQueryClient,
  clauseId: string | null,
  failureClass: string,
): Promise<BreakerVerdict> {
  const { rows: globalRows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM nous.macgruber_intake_log
      WHERE received_at >= now() - ($1 || ' minutes')::interval`,
    [String(GLOBAL_WINDOW_MINUTES)],
  );
  const globalCount = Number(globalRows[0]?.n ?? '0');
  if (globalCount >= GLOBAL_WINDOW_CAP) {
    return { allowed: false, reason: 'global_window_cap', pair_count: 0, global_count: globalCount };
  }
  if (!clauseId) {
    return { allowed: true, reason: 'ok', pair_count: 0, global_count: globalCount };
  }
  const { rows: pairRows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM nous.macgruber_intake_log
      WHERE clause_id = $1
        AND failure_class = $2
        AND received_at >= now() - ($3 || ' hours')::interval`,
    [clauseId, failureClass, String(PAIR_WINDOW_HOURS)],
  );
  const pairCount = Number(pairRows[0]?.n ?? '0');
  if (pairCount >= PER_PAIR_CAP) {
    return { allowed: false, reason: 'per_pair_cap', pair_count: pairCount, global_count: globalCount };
  }
  return { allowed: true, reason: 'ok', pair_count: pairCount, global_count: globalCount };
}

export interface IntakeLogEntry {
  intake_event_id: string;
  dispatch_id: string | null;
  clause_id: string | null;
  project: string;
  failure_class: string;
  source: string;
}

export async function recordIntake(
  db: ParamQueryClient,
  entry: IntakeLogEntry,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO nous.macgruber_intake_log
       (intake_event_id, dispatch_id, clause_id, project, failure_class, source)
     VALUES ($1, $2::uuid, $3, $4, $5, $6)
     RETURNING id::text`,
    [
      entry.intake_event_id,
      entry.dispatch_id,
      entry.clause_id,
      entry.project,
      entry.failure_class,
      entry.source,
    ],
  );
  return rows[0]?.id ?? null;
}

export async function recordOutcome(
  db: ParamQueryClient,
  intakeLogId: string,
  outcome: 'resolved' | 'escalated' | 'unresolved' | 'error',
  decisionId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE nous.macgruber_intake_log
        SET outcome = $2, decision_id = $3::uuid, completed_at = now()
      WHERE id = $1::uuid`,
    [intakeLogId, outcome, decisionId],
  );
}

export async function insertCapEscalation(
  db: ParamQueryClient,
  input: {
    clauseId: string | null;
    failureClass: string;
    project: string;
    reason: 'per_pair_cap' | 'global_window_cap';
    verdict: BreakerVerdict;
  },
): Promise<string | null> {
  // Dedup: one pending breaker escalation per (clause, class) is enough.
  const { rows: existing } = await db.query<{ id: string }>(
    `SELECT id::text FROM nous.decision_queue
      WHERE agent_id = 'macgruber'
        AND status = 'pending'
        AND bible_clause IS NOT DISTINCT FROM $1
        AND context->>'failure_class' = $2
      LIMIT 1`,
    [input.clauseId, input.failureClass],
  );
  if (existing[0]) return existing[0].id;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO nous.decision_queue
       (agent_id, project, bible_clause, question, context, urgency, status, error_summary)
     VALUES ('macgruber', $1, $2, $3, $4::jsonb, 'blocking', 'pending', $5)
     RETURNING id::text`,
    [
      input.project,
      input.clauseId,
      `MacGruber circuit breaker fired (${input.reason}) for ${input.clauseId ?? '(no clause)'} / ${input.failureClass}. Remediation halted; manual review required.`,
      JSON.stringify({ failure_class: input.failureClass, ...input.verdict }),
      `circuit_breaker:${input.reason}:pair=${input.verdict.pair_count},global=${input.verdict.global_count}`,
    ],
  );
  return rows[0]?.id ?? null;
}
