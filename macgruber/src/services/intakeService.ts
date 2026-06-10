import { query } from '../db.js';
import type { IntakePayload } from '../schemas/intakePayload.js';

export interface InsertedIntake {
  id: string;
  status: 'pending';
}

export async function persistIntake(payload: IntakePayload): Promise<InsertedIntake> {
  const result = await query<{ id: string }>(
    `INSERT INTO nous.healer_pending_approval
       (proposal_content, project, parent_run_id, status)
     VALUES ($1::jsonb, $2, $3::uuid, 'pending')
     RETURNING id`,
    [JSON.stringify(payload), payload.repo, payload.dispatch_event_id ?? null],
  );
  return { id: result.rows[0]!.id, status: 'pending' };
}

export interface ValidationFailure {
  reportedFromProducer?: string | undefined;
  errorMessage: string;
  failingFields: ReadonlyArray<{ path: string; message: string }>;
  rawPayloadSnippet: string;
}

export async function recordValidationFailure(failure: ValidationFailure): Promise<void> {
  const quote = `intake validation failed (${failure.failingFields.length} field(s)): ${failure.errorMessage}`;
  const rootCause = `producer=${failure.reportedFromProducer ?? 'unknown'} sent malformed intake payload`;
  const proposedFix =
    `Update producer to match macgruber/src/schemas/intakePayload.ts. Failing: ` +
    failure.failingFields.map((f) => `${f.path} (${f.message})`).join('; ');

  await query(
    `INSERT INTO nous.friction
       (quote, category, tier, status, root_cause, proposed_fix, project, reported_by, severity)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'macgruber', $8)`,
    [
      quote,
      'pipeline_contract',
      'tier2',
      'open',
      rootCause,
      proposedFix,
      failure.reportedFromProducer ?? 'unknown',
      3,
    ],
  );
}
