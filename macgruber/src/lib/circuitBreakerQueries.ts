import { query } from '../db.js';

export const PER_PAIR_CAP = 2;
export const GLOBAL_WINDOW_MINUTES = 60;
export const GLOBAL_WINDOW_CAP = 10;

export async function checkPairCount(
  clauseId: string,
  failureClass: string,
): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM nous.circuit_breaker_log
      WHERE clause_id = $1
        AND failure_class = $2`,
    [clauseId, failureClass],
  );
  return Number(result.rows[0]?.n ?? '0');
}

export async function checkGlobalWindow(): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM nous.circuit_breaker_log
      WHERE attempted_at >= NOW() - ($1 || ' minutes')::interval`,
    [String(GLOBAL_WINDOW_MINUTES)],
  );
  return Number(result.rows[0]?.n ?? '0');
}

export interface AttemptRecord {
  clauseId: string;
  failureClass: string;
  intakeId?: string | null;
}

export async function recordAttempt(attempt: AttemptRecord): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO nous.circuit_breaker_log
       (clause_id, failure_class, intake_id, attempted_at)
     VALUES ($1, $2, $3::uuid, NOW())
     RETURNING id`,
    [attempt.clauseId, attempt.failureClass, attempt.intakeId ?? null],
  );
  return result.rows[0]!.id;
}

export interface EscalationRecord {
  clauseId: string;
  failureClass: string;
  reason: 'per_pair_cap' | 'global_window_cap';
  errorSummary: string;
  intakeContext: Record<string, unknown>;
}

export async function insertEscalation(esc: EscalationRecord): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO nous.decision_queue
       (agent_id, project, bible_clause, question, context,
        urgency, status, error_summary)
     VALUES ('macgruber', 'nous-agents', $1, $2, $3::jsonb,
             'high', 'open', $4)
     RETURNING id`,
    [
      esc.clauseId,
      `Circuit breaker fired (${esc.reason}) on ${esc.clauseId} / ${esc.failureClass}. Investigation halted; manual review required.`,
      JSON.stringify({ failure_class: esc.failureClass, ...esc.intakeContext }),
      esc.errorSummary,
    ],
  );

  await query(
    `UPDATE nous.circuit_breaker_log
        SET escalated = true
      WHERE clause_id = $1
        AND failure_class = $2`,
    [esc.clauseId, esc.failureClass],
  );

  return result.rows[0]!.id;
}
