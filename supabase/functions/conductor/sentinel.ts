// supabase/functions/conductor/sentinel.ts
// AGT.1.1.4 — Sentinel 5-axis scoring via claude-haiku-4-5 (station-proxy).
// AGT.1.1.4.1 — Calibration v2: incomplete-step penalty, no client-side
// truncation, function-boundary chunking for >100KB inputs.
//
// Cold-read scoring: receives ONLY diff + ACs + pillar_results. Never sees
// worker self-narrative or logs — that's the whole point. Self-reports are
// optimistic; mechanical scoring catches what narrative obscures.
//
// Calibration v2 bands: 85+ ships clean, 75-84 ships_with_amendments,
// 60-74 fail_tactical, <60 fail_strategic. The rubric prompt explicitly
// instructs the model to drop correctness 5-10 per missing spec step
// BEFORE summing the axis total — this fixes the "5 of 6 steps shipped
// but scored 78" inflation seen in cowork-2026-05-23.

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
  chunked?: boolean;
  chunk_count?: number;
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
  85+ = ships clean. Solid, no blockers, no notable amendments.
  75-84 = ships with notable amendments (an auto-followup clause will be spawned).
  60-74 = fail_tactical. Needs ≤2 small fixes; same worker can amend.
  <60 = fail_strategic. Structural problems; escalate to Scoper for rescoping.

INCOMPLETE-STEP PENALTY (HARD RULE): If the clause body enumerates N specific
steps/files/modules (e.g., a 6-step verify playbook, a 9-step merge playbook,
or "files touched" list) and the diff is MISSING ANY of them, drop correctness
by 5-10 PER MISSING PIECE BEFORE summing the axis total. A clause whose spec
defines N steps and ships with N-3 steps present CANNOT score above 70 on
correctness — half the playbook absent is not "ships clean," it is tactical
retry territory. When you detect missing pieces, name them explicitly in
amendments_suggested using the literal step/AC reference (e.g., "Step 1",
"Step 4", "AC07") so the conductor override can detect the gap.

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
  "notes": "<2-4 sentences: what's strong, what's weak; name missing steps/files explicitly>",
  "amendments_suggested": ["<short, actionable hint — reference Step N or ACNN by name when relevant>", "..."]
}

The score field is computed by the caller — you only return per_axis. If an
axis is not applicable (e.g. no migration touched, so deployability is N/A),
award the full cap rather than zero.`;

// ─── Constants ───────────────────────────────────────────────────────────────

// Haiku's 200k context window comfortably handles single calls up to ~100KB
// of diff. Above that we chunk on function boundaries rather than silently
// truncating — past truncation bug (cowork-2026-05-23) cost real points.
const CHUNK_BYTE_THRESHOLD = 100_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripJsonFences(s: string): string {
  // Models sometimes wrap JSON in ```json ... ``` despite instructions. Strip both
  // ```json and bare ``` fences. Match is non-greedy so trailing prose is safe.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // Fallback: model omitted closing fence — extract first { to last }
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return s.slice(firstBrace, lastBrace + 1);
  }
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

/**
 * Split a large diff_content into chunks on function/class boundaries so each
 * chunk fits comfortably in a single Haiku call. Boundaries we recognise:
 *   - The `### <status> <filename>` headers emitted by verify.ts's flattenDiff
 *   - TypeScript / JavaScript top-level declarations:
 *       export function / export async function / export const / export class
 *       function / async function / class
 *   - Markdown headings (`## ` / `### `) as a fallback for non-code diffs
 *
 * Returns an array of chunk strings, each ≤ CHUNK_BYTE_THRESHOLD. Never
 * silently drops content — if a single logical unit exceeds the threshold
 * we still emit it as its own chunk (the worst case is a single oversized
 * function, which Haiku can still ingest at ~200KB).
 */
export function chunkDiffByFunctionBoundary(diff: string): string[] {
  if (!diff || diff.length <= CHUNK_BYTE_THRESHOLD) {
    return [diff];
  }

  // Boundary regex: anchored to line starts. Anything matching this opens
  // a new chunk-candidate. Order matters only insofar as the regex is a
  // single alternation — any match suffices.
  const BOUNDARY_RE =
    /^(### [a-z]+ \S+|export\s+(?:async\s+)?(?:function|const|class)\s+[A-Za-z_]|(?:async\s+)?function\s+[A-Za-z_]|class\s+[A-Za-z_]|##\s+\S)/m;

  const chunks: string[] = [];
  let cursor = 0;
  let pendingStart = 0;

  while (cursor < diff.length) {
    // Advance cursor up to the threshold, then find the next safe boundary.
    let targetEnd = Math.min(pendingStart + CHUNK_BYTE_THRESHOLD, diff.length);

    if (targetEnd >= diff.length) {
      chunks.push(diff.slice(pendingStart));
      break;
    }

    // Search forward from targetEnd for the next boundary. If we hit EOF
    // without finding one, take the whole remainder as the last chunk —
    // never silently truncate.
    const tail = diff.slice(targetEnd);
    const m = BOUNDARY_RE.exec(tail);
    if (!m) {
      chunks.push(diff.slice(pendingStart));
      break;
    }
    const splitAt = targetEnd + m.index;
    chunks.push(diff.slice(pendingStart, splitAt));
    pendingStart = splitAt;
    cursor = splitAt;
  }

  // Defensive: if chunking produced an empty array (shouldn't happen),
  // fall back to a single chunk so we never lose content.
  if (chunks.length === 0) return [diff];
  return chunks;
}

function buildUserMessage(opts: {
  clause_id: string;
  acs: ACRow[];
  pillar_results: PillarResults | undefined;
  diff_content: string;
  chunk_label?: string;
}): string {
  return [
    `Clause: ${opts.clause_id}${opts.chunk_label ? `  (${opts.chunk_label})` : ""}`,
    "",
    "Acceptance Criteria:",
    formatACs(opts.acs),
    "",
    "Pillar Results:",
    formatPillars(opts.pillar_results),
    "",
    "Diff:",
    "```",
    opts.diff_content || "(empty diff)",
    "```",
  ].join("\n");
}

interface SingleCallResult {
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

async function callSentinel(opts: {
  proxyUrl: string;
  apiKey: string;
  userMessage: string;
}): Promise<SingleCallResult> {
  const requestBody = {
    model: "haiku",
    max_tokens: 1024,
    system: RUBRIC_PROMPT,
    messages: [{ role: "user", content: opts.userMessage }],
    account: "c2",
  };

  const response = await fetch(`${opts.proxyUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
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

  const tokens = tokensFromResponse(parsed);
  const cost_usd = costFromTokens("claude-haiku-4-5", tokens.tokens_in, tokens.tokens_out);

  return {
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Inline 5-axis Sentinel scoring via station-proxy → claude-haiku-4-5.
 *
 * COLD-READ: input is deliberately limited to clause_id + ACs + diff + pillars.
 * Never accepts worker_self_narrative / worker_log / worker_result.
 *
 * NO CLIENT-SIDE TRUNCATION: full diff_content is sent to the model. If the
 * diff exceeds CHUNK_BYTE_THRESHOLD bytes (~100KB), we split on function
 * boundaries and average the per-chunk scores rather than silently dropping
 * content. The result includes `chunked: true` and `chunk_count` so callers
 * (verify.ts) can log the fallback firing.
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

  const fullDiff = opts.diff_content ?? "";
  const needsChunking = fullDiff.length > CHUNK_BYTE_THRESHOLD;

  if (!needsChunking) {
    const userMessage = buildUserMessage({
      clause_id: opts.clause_id,
      acs: opts.acceptance_criteria,
      pillar_results: opts.pillar_results,
      diff_content: fullDiff,
    });
    const single = await callSentinel({ proxyUrl, apiKey, userMessage });
    const score =
      single.per_axis.correctness +
      single.per_axis.robustness +
      single.per_axis.architecture +
      single.per_axis.security +
      single.per_axis.deployability;
    return {
      score,
      per_axis: single.per_axis,
      notes: single.notes,
      amendments_suggested: single.amendments_suggested,
      tokens_in: single.tokens_in,
      tokens_out: single.tokens_out,
      cost_usd: single.cost_usd,
      raw_response: single.raw_response,
      chunked: false,
      chunk_count: 1,
    };
  }

  // ── Chunked path: function-boundary split + weighted-average scoring ───
  console.warn(
    `[sentinel] diff_content is ${fullDiff.length} bytes (>${CHUNK_BYTE_THRESHOLD}); ` +
      `chunking by function boundary to preserve full context`,
  );

  const chunks = chunkDiffByFunctionBoundary(fullDiff);
  const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
  const results: SingleCallResult[] = [];
  let agg_tokens_in = 0;
  let agg_tokens_out = 0;
  let agg_cost = 0;

  for (let i = 0; i < chunks.length; i++) {
    const userMessage = buildUserMessage({
      clause_id: opts.clause_id,
      acs: opts.acceptance_criteria,
      pillar_results: opts.pillar_results,
      diff_content: chunks[i],
      chunk_label: `chunk ${i + 1} of ${chunks.length}, ${chunks[i].length} bytes`,
    });
    const r = await callSentinel({ proxyUrl, apiKey, userMessage });
    results.push(r);
    agg_tokens_in += r.tokens_in;
    agg_tokens_out += r.tokens_out;
    agg_cost += r.cost_usd;
  }

  // Weighted average by chunk byte size — large chunks count more.
  const weight = (i: number) => chunks[i].length / Math.max(totalBytes, 1);
  const wavg = (sel: (r: SingleCallResult) => number) =>
    Math.round(results.reduce((acc, r, i) => acc + sel(r) * weight(i), 0));

  const per_axis = {
    correctness: wavg((r) => r.per_axis.correctness),
    robustness: wavg((r) => r.per_axis.robustness),
    architecture: wavg((r) => r.per_axis.architecture),
    security: wavg((r) => r.per_axis.security),
    deployability: wavg((r) => r.per_axis.deployability),
  };
  const score =
    per_axis.correctness +
    per_axis.robustness +
    per_axis.architecture +
    per_axis.security +
    per_axis.deployability;

  const combinedNotes = results
    .map((r, i) => `[chunk ${i + 1}/${chunks.length}] ${r.notes}`)
    .join("\n");
  const combinedAmendments = results.flatMap((r) => r.amendments_suggested);

  return {
    score,
    per_axis,
    notes:
      `[CHUNKED: input ${fullDiff.length} bytes split into ${chunks.length} chunks on function boundaries]\n` +
      combinedNotes,
    amendments_suggested: combinedAmendments,
    tokens_in: agg_tokens_in,
    tokens_out: agg_tokens_out,
    cost_usd: agg_cost,
    raw_response: JSON.stringify(results.map((r) => r.raw_response)),
    chunked: true,
    chunk_count: chunks.length,
  };
}
