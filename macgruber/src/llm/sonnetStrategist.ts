import type { FixStrategy, InvestigationContext, SeverityLevel } from '../router/types.js';
import { SEVERITY_LEVELS } from '../router/types.js';
import { complete } from './llmClient.js';

const SONNET_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are MacGruber's fix-strategy author.
Given a pipeline failure payload, recent clause history, and the available repo context, produce ONE JSON object with this exact shape:

{
  "summary": "<one sentence describing the fix>",
  "approach": "amend_inline" | "rescope_clause" | "manual_review" | "defer",
  "files_to_modify": [{ "path": "<repo-relative path>", "reason": "<why this file>" }],
  "estimated_risk": "low" | "medium" | "high" | "critical",
  "notes": "<optional extra context>"
}

Constraints:
- Prefer amend_inline for compile / lint / missing-dep / test failures.
- Choose rescope_clause if the clause's spec is incompatible with the current code state.
- Choose manual_review if you cannot determine a safe automated path.
- Reply with ONLY the JSON object — no preamble, no markdown fence.`;

interface SonnetResponse {
  strategy: FixStrategy;
  raw: unknown;
}

function isFixStrategy(value: unknown): value is FixStrategy {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== 'string') return false;
  const approaches = ['amend_inline', 'rescope_clause', 'manual_review', 'defer'];
  if (typeof v.approach !== 'string' || !approaches.includes(v.approach)) return false;
  if (!Array.isArray(v.files_to_modify)) return false;
  for (const f of v.files_to_modify) {
    if (!f || typeof f !== 'object') return false;
    const fr = f as Record<string, unknown>;
    if (typeof fr.path !== 'string' || typeof fr.reason !== 'string') return false;
  }
  if (
    typeof v.estimated_risk !== 'string' ||
    !SEVERITY_LEVELS.includes(v.estimated_risk as SeverityLevel)
  ) {
    return false;
  }
  if (v.notes !== undefined && typeof v.notes !== 'string') return false;
  return true;
}

function parseStrategy(text: string): FixStrategy {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`sonnetStrategist: response was not valid JSON: ${text.slice(0, 200)}`);
  }
  if (!isFixStrategy(parsed)) {
    throw new Error(`sonnetStrategist: invalid FixStrategy shape: ${text.slice(0, 200)}`);
  }
  return parsed;
}

export async function proposeStrategy(
  ctx: InvestigationContext,
  haikuSeverity: SeverityLevel,
): Promise<SonnetResponse> {
  const user = JSON.stringify(
    {
      severity: haikuSeverity,
      clause_id: ctx.payload.clause_id,
      failure_class: ctx.payload.failure_class,
      error_message: ctx.payload.error_message,
      step_attempted: ctx.payload.step_attempted,
      prior_attempts: ctx.payload.prior_attempts,
      stack_trace: ctx.payload.stack_trace?.slice(0, 6000),
      clause_history: ctx.clauseHistory,
      github_context: ctx.githubContext,
    },
    null,
    2,
  );
  const res = await complete({
    model: SONNET_MODEL,
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 2000,
  });
  return { strategy: parseStrategy(res.text), raw: res.raw };
}
