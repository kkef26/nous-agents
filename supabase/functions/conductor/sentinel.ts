// supabase/functions/conductor/sentinel.ts
// AGT.1.1.4 — Sentinel 5-axis scoring via claude-haiku-4-5 (station-proxy).
//
// Cold-read scoring: receives ONLY diff + ACs + pillar_results. Never sees
// worker self-narrative or logs — that's the whole point. Self-reports are
// optimistic; mechanical scoring catches what narrative obscures.
//
// Calibrated against shipped work — anchors are 75/60/40, not 95/80/60.

import {
  costFromTokens,
  tokensFromResponse,
} from "../_common/cost.ts";
import type { AnthropicResponseLike, PillarOutcome } from "../_common/types.ts";

// ─── Local types ─────────────────────────────────────────────────────────────

export interface ACRow {
  id?: string | number;
  text: string;
  verification?: "auto" | "physical_qa" | "kosta_review";
}

export type PillarResults = PillarOutcome[] | Record<string, "pass" | "fail" | "warn">;

export interface ScoreWith5AxisInput {
  clause_id: string;
  acceptance_criteria: ACRow[];
  diff_content: string;
  pillar_results?: PillarResults;
}

export interface ScoreWith5AxisResult {
  score: number;
  per_axis: {
    correctness: number;
    robustness: number;
    architecture: number;
    security: number;
    deployability: number;
  };
  notes: string;
  amendments_suggested: string[];
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  raw_response: string;
}

// ─── Rubric prompt ───────────────────────────────────────────────────────────

const RUBRIC_PROMPT = `You are Sentinel, a cold-read code-quality scorer. You see ONLY the diff,
the acceptance criteria, and (optionally) the 6-pillar mechanical check results.
You do NOT see worker self-reports or narrative. That is deliberate.

Score the diff on a 100-point 5-axis rubric. Point caps are hard maximums:

  - correctness   (0-30) : ACs pass + edge cases not obviously broken
  - robustness    (0-20) : error handling present, null/empty inputs handled
  - architecture  (0-20) : matches CONTEXT.md/ARCHITECTURE.md patterns, no anti-patterns
  - security      (0-15) : no leaked credentials, RLS where needed, input validation
  - deployability (0-15) : build passes, no migration that breaks existing data

Calibration anchors (be honest — do not inflate):
  75 = ships. Solid, no blockers, may have minor notes.
  60 = tactical retry. Needs ≤2 small fixes; same worker can amend.
  40 = strategic rescope. Structural problems; escalate to Scoper.

A skeleton task done correctly may legitimately score 90+. A 30-line bugfix
that nails the AC and adds a regression test belongs in the 80s. Be calibrated.

Return ONLY valid JSON in this exact shape (no prose, no markdown fences):

{
  "per_axis": {
    "correctness": <0-30>,
    "robustness": <0-20>,
    "architecture": <0-20>,
    "security": <0-15>,
    "deployability": <0-15>
  },
  "notes": "<2-4 sentences: what's strong, what's weak>",
  "amendments_suggested": ["<short, actionable hint>", "..."]
}

The score field is computed by the caller — you only return per_axis. If an
axis is not applicable (e.g. no migration touched, so deployability is N/A),
award the full cap rather than zero.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripJsonFences(s: string): string {
  // Models sometimes wrap JSON in ```json ... ``` despite instructions. Strip both
  // ```json and bare ``` fences. Match is non-greedy so trailing prose is safe.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}

function clampAxis(n: unknown, cap: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (v < 0) return 0;
  if (v > cap) return cap;
  return Math.round(v);
}

function formatACs(acs: ACRow[]): string {
  if (!acs || acs.length === 0) return "(no acceptance criteria provided)";
  return acs
    .map((a, i) => {
      const verif = a.verification ? ` [${a.verification}]` : "";
      return `${i + 1}.${verif} ${a.text}`;
    })
    .join("\n");
}

function formatPillars(p: PillarResults | undefined): string {
  if (!p) return "(no pillar results — sentinel running standalone)";
  if (Array.isArray(p)) {
    return p
      .map((row) => `- ${row.name}: ${row.result}${row.detail ? ` (${row.detail})` : ""}`)
      .join("\n");
  }
  return Object.entries(p)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Inline 5-axis Sentinel scoring via station-proxy → claude-haiku-4-5.
 *
 * COLD-READ: input is deliberately limited to clause_id + ACs + diff + pillars.
 * Never accepts worker_self_narrative / worker_log / worker_result.
 *
 * Throws on transport / parse failure — caller (verify.ts) decides whether to
 * surface as conductor_log.error or retry. We do not silently swallow.
 */
export async function scoreWith5Axis(
  opts: ScoreWith5AxisInput,
): Promise<ScoreWith5AxisResult> {
  const proxyUrl = Deno.env.get("STATION_PROXY_URL") ?? "http://54.174.233.250:8095";
  const apiKey = Deno.env.get("STATION_PROXY_API_KEY");
  if (!apiKey) {
    throw new Error("STATION_PROXY_API_KEY not set in environment");
  }

  const userMessage = [
    `Clause: ${opts.clause_id}`,
    "",
    "Acceptance Criteria:",
    formatACs(opts.acceptance_criteria),
    "",
    "Pillar Results:",
    formatPillars(opts.pillar_results),
    "",
    "Diff:",
    "```",
    opts.diff_content || "(empty diff)",
    "```",
  ].join("\n");

  const requestBody = {
    model: "haiku",
    max_tokens: 1024,
    system: RUBRIC_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    account: "c2",
  };

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(requestBody),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`station-proxy ${response.status}: ${raw.slice(0, 400)}`);
  }

  let parsed: AnthropicResponseLike & {
    content?: Array<{ type: string; text: string }>;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `station-proxy returned non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`,
    );
  }

  const textBlock = parsed.content?.find((c) => c.type === "text");
  const rubricText = textBlock?.text ?? "";
  const cleaned = stripJsonFences(rubricText);

  let rubric: {
    per_axis?: Record<string, number>;
    notes?: string;
    amendments_suggested?: string[];
  };
  try {
    rubric = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Sentinel rubric JSON parse failed: ${(err as Error).message}: ${cleaned.slice(0, 200)}`,
    );
  }

  const ax = rubric.per_axis ?? {};
  const per_axis = {
    correctness: clampAxis(ax.correctness, 30),
    robustness: clampAxis(ax.robustness, 20),
    architecture: clampAxis(ax.architecture, 20),
    security: clampAxis(ax.security, 15),
    deployability: clampAxis(ax.deployability, 15),
  };
  const score =
    per_axis.correctness +
    per_axis.robustness +
    per_axis.architecture +
    per_axis.security +
    per_axis.deployability;

  const tokens = tokensFromResponse(parsed);
  const cost_usd = costFromTokens("claude-haiku-4-5", tokens.tokens_in, tokens.tokens_out);

  return {
    score,
    per_axis,
    notes: typeof rubric.notes === "string" ? rubric.notes : "",
    amendments_suggested: Array.isArray(rubric.amendments_suggested)
      ? rubric.amendments_suggested.filter((s): s is string => typeof s === "string")
      : [],
    tokens_in: tokens.tokens_in,
    tokens_out: tokens.tokens_out,
    cost_usd,
    raw_response: raw,
  };
}
