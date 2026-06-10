import type { NextFunction, Request, Response } from 'express';
import {
  GLOBAL_WINDOW_CAP,
  PER_PAIR_CAP,
  checkGlobalWindow,
  checkPairCount,
  insertEscalation,
  recordAttempt,
} from '../lib/circuitBreakerQueries.js';

interface IntakeBody {
  clause_id?: unknown;
  failure_class?: unknown;
}

function readIntakeKeys(req: Request): { clauseId: string; failureClass: string } | null {
  if (req.method !== 'POST' || !req.path.endsWith('/intake')) return null;
  const body = req.body as IntakeBody | undefined;
  if (!body || typeof body !== 'object') return null;
  const clauseId = typeof body.clause_id === 'string' ? body.clause_id : null;
  const failureClass =
    typeof body.failure_class === 'string' ? body.failure_class : 'unknown';
  if (!clauseId) return null;
  return { clauseId, failureClass };
}

export async function circuitBreakerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const keys = readIntakeKeys(req);
  if (!keys) {
    next();
    return;
  }
  const { clauseId, failureClass } = keys;

  try {
    const pairCount = await checkPairCount(clauseId, failureClass);
    if (pairCount >= PER_PAIR_CAP) {
      const escalationId = await insertEscalation({
        clauseId,
        failureClass,
        reason: 'per_pair_cap',
        errorSummary: `per-pair cap (${PER_PAIR_CAP}) reached for ${clauseId} / ${failureClass}`,
        intakeContext: (req.body as Record<string, unknown>) ?? {},
      });
      res.status(429).json({
        error: 'circuit_breaker_per_pair_cap',
        cap: PER_PAIR_CAP,
        pair: { clause_id: clauseId, failure_class: failureClass },
        decision_queue_id: escalationId,
      });
      return;
    }

    const globalCount = await checkGlobalWindow();
    if (globalCount >= GLOBAL_WINDOW_CAP) {
      const escalationId = await insertEscalation({
        clauseId,
        failureClass,
        reason: 'global_window_cap',
        errorSummary: `global rolling-window cap (${GLOBAL_WINDOW_CAP} in 60min) reached`,
        intakeContext: (req.body as Record<string, unknown>) ?? {},
      });
      res.status(429).json({
        error: 'circuit_breaker_global_cap',
        cap: GLOBAL_WINDOW_CAP,
        window_minutes: 60,
        decision_queue_id: escalationId,
      });
      return;
    }

    await recordAttempt({ clauseId, failureClass, intakeId: null });
    next();
  } catch (err) {
    process.stderr.write(`circuitBreaker: ${(err as Error).message}\n`);
    res.status(500).json({ error: 'circuit_breaker_internal' });
  }
}
