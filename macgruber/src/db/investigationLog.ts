import { query } from '../db.js';
import type { FailureClass, FixStrategy, SeverityLevel } from '../router/types.js';

export interface InvestigationInsert {
  intakeId: string;
  clauseId: string;
  failureClass: FailureClass;
  handler: string;
  severity: SeverityLevel;
  llmSonnetInvoked: boolean;
  fixStrategy: FixStrategy | null;
  haikuRaw: unknown;
  sonnetRaw: unknown;
}

export async function insertInvestigation(row: InvestigationInsert): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO nous.investigation_log
       (intake_id, clause_id, failure_class, handler,
        severity, llm_sonnet_invoked, fix_strategy, haiku_raw, sonnet_raw)
     VALUES ($1::uuid, $2, $3, $4,
             $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)
     RETURNING id`,
    [
      row.intakeId,
      row.clauseId,
      row.failureClass,
      row.handler,
      row.severity,
      row.llmSonnetInvoked,
      row.fixStrategy ? JSON.stringify(row.fixStrategy) : null,
      row.haikuRaw ? JSON.stringify(row.haikuRaw) : null,
      row.sonnetRaw ? JSON.stringify(row.sonnetRaw) : null,
    ],
  );
  return result.rows[0]!.id;
}

export async function updateSonnetInvocation(
  id: string,
  fixStrategy: FixStrategy,
  sonnetRaw: unknown,
): Promise<void> {
  await query(
    `UPDATE nous.investigation_log
        SET llm_sonnet_invoked = true,
            fix_strategy        = $2::jsonb,
            sonnet_raw          = $3::jsonb
      WHERE id = $1::uuid`,
    [id, JSON.stringify(fixStrategy), JSON.stringify(sonnetRaw)],
  );
}
