import { Router, type Request, type Response } from 'express';
import { routeByFailureClass } from '../router/failureClassRouter.js';
import type { InvestigationContext } from '../router/types.js';
import { IntakePayloadSchema } from '../schemas/intakePayload.js';
import { persistIntake, recordValidationFailure } from '../services/intakeService.js';

export const intakeRouter = Router();

intakeRouter.post('/intake', async (req: Request, res: Response) => {
  const parsed = IntakePayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    const failingFields = parsed.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    const producer =
      typeof req.body === 'object' && req.body && 'reported_by' in req.body
        ? String((req.body as { reported_by?: unknown }).reported_by)
        : undefined;
    void recordValidationFailure({
      reportedFromProducer: producer,
      errorMessage: parsed.error.message,
      failingFields,
      rawPayloadSnippet: JSON.stringify(req.body).slice(0, 512),
    }).catch((err: unknown) => {
      process.stderr.write(`intake: friction write failed: ${(err as Error).message}\n`);
    });
    return res.status(400).json({
      error: 'invalid_payload',
      failing_fields: failingFields,
    });
  }

  let intakeId: string;
  try {
    const inserted = await persistIntake(parsed.data);
    intakeId = inserted.id;
    res.status(202).json({ id: inserted.id, status: inserted.status });
  } catch (err) {
    process.stderr.write(`intake: persist failed: ${(err as Error).message}\n`);
    return res.status(500).json({ error: 'intake_persist_failed' });
  }

  const ctx: InvestigationContext = {
    intakeId,
    payload: parsed.data,
    clauseHistory: [],
    githubContext: {
      repo: parsed.data.repo,
      branch: parsed.data.branch,
      sha: parsed.data.sha,
    },
  };
  void routeByFailureClass(ctx).catch((err: unknown) => {
    process.stderr.write(
      `intake: investigation failed (${intakeId}): ${(err as Error).message}\n`,
    );
  });

  return undefined;
});
