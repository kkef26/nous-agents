import type { InvestigationContext, SeverityLevel } from '../router/types.js';
import { SEVERITY_LEVELS } from '../router/types.js';
import { complete } from './llmClient.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are MacGruber's severity classifier.
Given a structured pipeline-failure payload, return EXACTLY one JSON object with a single field "severity" whose value is one of: low, medium, high, critical.

Severity guide:
- low: cosmetic, single-file lint or formatting issue. Auto-fixable.
- medium: contained bug, dependency mismatch, or missing import. Needs targeted patch.
- high: cross-file regression, schema drift, or test suite failure with unclear blast radius.
- critical: data loss risk, production incident signal, security boundary breach. STOP — no auto-remediation.

Reply with ONLY the JSON object — no preamble, no markdown fence.`;

interface HaikuResponse {
  severity: SeverityLevel;
  raw: unknown;
}

function parseSeverity(text: string): SeverityLevel {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`haikuClassifier: response was not valid JSON: ${text.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('severity' in parsed)) {
    throw new Error('haikuClassifier: response missing "severity" field');
  }
  const value = (parsed as { severity: unknown }).severity;
  if (typeof value !== 'string' || !SEVERITY_LEVELS.includes(value as SeverityLevel)) {
    throw new Error(`haikuClassifier: invalid severity value: ${String(value)}`);
  }
  return value as SeverityLevel;
}

export async function classifySeverity(ctx: InvestigationContext): Promise<HaikuResponse> {
  const user = JSON.stringify(
    {
      clause_id: ctx.payload.clause_id,
      failure_class: ctx.payload.failure_class,
      error_message: ctx.payload.error_message,
      step_attempted: ctx.payload.step_attempted,
      prior_attempts: ctx.payload.prior_attempts,
      stack_trace: ctx.payload.stack_trace?.slice(0, 4000),
      clause_history_count: ctx.clauseHistory.length,
    },
    null,
    2,
  );
  const res = await complete({
    model: HAIKU_MODEL,
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 100,
  });
  return { severity: parseSeverity(res.text), raw: res.raw };
}
