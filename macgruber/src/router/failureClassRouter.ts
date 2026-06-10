import { insertInvestigation, updateSonnetInvocation } from '../db/investigationLog.js';
import { classifySeverity } from '../llm/haikuClassifier.js';
import { proposeStrategy } from '../llm/sonnetStrategist.js';
import type { FailureClass, InvestigationContext, InvestigationResult } from './types.js';

type Handler = (ctx: InvestigationContext) => Promise<InvestigationResult>;

async function defaultHandler(
  ctx: InvestigationContext,
  handlerLabel: FailureClass,
): Promise<InvestigationResult> {
  const haiku = await classifySeverity(ctx);

  const investigationId = await insertInvestigation({
    intakeId: ctx.intakeId,
    clauseId: ctx.payload.clause_id,
    failureClass: handlerLabel,
    handler: handlerLabel,
    severity: haiku.severity,
    llmSonnetInvoked: false,
    fixStrategy: null,
    haikuRaw: haiku.raw,
    sonnetRaw: null,
  });

  if (haiku.severity === 'critical') {
    return {
      investigationId,
      severity: haiku.severity,
      handler: handlerLabel,
      fixStrategy: null,
      sonnetInvoked: false,
    };
  }

  const sonnet = await proposeStrategy(ctx, haiku.severity);
  await updateSonnetInvocation(investigationId, sonnet.strategy, sonnet.raw);

  return {
    investigationId,
    severity: haiku.severity,
    handler: handlerLabel,
    fixStrategy: sonnet.strategy,
    sonnetInvoked: true,
  };
}

const ROUTING_TABLE: Record<FailureClass, Handler> = {
  compile_error: (ctx) => defaultHandler(ctx, 'compile_error'),
  test_failure: (ctx) => defaultHandler(ctx, 'test_failure'),
  lint_error: (ctx) => defaultHandler(ctx, 'lint_error'),
  merge_conflict: (ctx) => defaultHandler(ctx, 'merge_conflict'),
  missing_dependency: (ctx) => defaultHandler(ctx, 'missing_dependency'),
  runtime_error: (ctx) => defaultHandler(ctx, 'runtime_error'),
  integration_error: (ctx) => defaultHandler(ctx, 'integration_error'),
  unknown: (ctx) => defaultHandler(ctx, 'unknown'),
};

export async function routeByFailureClass(
  ctx: InvestigationContext,
): Promise<InvestigationResult> {
  const failureClass: FailureClass = ctx.payload.failure_class ?? 'unknown';
  const handler = ROUTING_TABLE[failureClass];
  return handler(ctx);
}

export function listRoutedClasses(): ReadonlyArray<FailureClass> {
  return Object.keys(ROUTING_TABLE) as FailureClass[];
}
