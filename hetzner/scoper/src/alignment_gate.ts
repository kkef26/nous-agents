// hetzner/scoper/src/alignment_gate.ts
// D5 — Haiku alignment gate for generated clauses.
// Cold-reads generated clauses against source material (grill decisions,
// architecture, resolutions) and flags misalignments before dispatch.
// Same pattern as Sentinel but pre-dispatch.

import { loadFeatureSourceMaterial } from "./lib/common/source_material.js";
import type { FeatureSourceMaterial } from "./lib/common/source_material.js";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ClauseForReview {
  id: string;
  title: string;
  clause_type: string;
  critical_path: boolean;
  body: string;
  acceptance_criteria: Array<{ id: string; text: string; verification: string }>;
}

interface FlaggedClause {
  clause_id: string;
  issue: string;
  severity: "blocker" | "warning";
  suggestion: string;
}

interface AlignmentResult {
  passed: boolean;
  flagged: FlaggedClause[];
  reasoning: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

interface AlignmentLLMOutput {
  passed: boolean;
  flagged: FlaggedClause[];
  reasoning: string;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const ALIGNMENT_SYSTEM_PROMPT = `You are a quality gate reviewer for the NOUS factory pipeline.
You are reviewing GENERATED clauses (created by an LLM) against the original source
material (grill decisions, architecture docs, grill resolutions) that they were
generated from.

Your job is to catch misalignments BEFORE these clauses are dispatched to workers.

## What to check

1. **Grill decision coverage**: Every resolved grill decision must be reflected in at
   least one clause body, AC, or antipattern. Missing a grill decision means the
   worker will build the wrong thing.

2. **Architecture compliance**: If an architecture doc specifies patterns, file
   structure, or conventions, clauses must follow them.

3. **Scope creep**: Clauses should not include work that was explicitly deferred in
   grill resolutions. Check the deferred items list.

4. **AC quality**: ACs must be independently verifiable. "auto" ACs must have concrete
   verification commands. Generic ACs like "works correctly" are a flag.

5. **Dependency sanity**: requires/enables chains should make sense (no circular deps,
   foundation before features, migrations before code).

6. **Right-sizing**: Any clause that looks like >60min of work for a senior dev should
   be flagged for splitting.

## Output

Output ONLY valid JSON (no prose, no markdown fences):
{
  "passed": true|false,
  "flagged": [
    {
      "clause_id": "...",
      "issue": "what's wrong",
      "severity": "blocker|warning",
      "suggestion": "how to fix"
    }
  ],
  "reasoning": "1-2 sentence overall assessment"
}

Rules:
- passed=true if zero blockers (warnings are okay)
- passed=false if any blocker exists
- Be concise — this is a gate check, not a literary review
- Only flag REAL issues — do not invent problems`;

// ─── Build review message ───────────────────────────────────────────────────

function buildAlignmentMessage(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauses: ClauseForReview[],
  sourceMaterial: FeatureSourceMaterial,
): string {
  const parts: string[] = [];

  parts.push(`## Feature: ${featureId} — ${featureName ?? "(unnamed)"}`);
  parts.push(`Description: ${description ?? "(none)"}`);

  // Source material summary
  parts.push(`\n## Source Material (what clauses should align to)`);

  if (sourceMaterial.grill_decisions.length > 0) {
    parts.push(`\n### Grill Decisions (${sourceMaterial.grill_decisions.length})`);
    for (const gd of sourceMaterial.grill_decisions) {
      parts.push(`- [${gd.source_id}] ${gd.title ?? ""}: ${(gd.content ?? "").slice(0, 300)}`);
    }
  }

  if (sourceMaterial.architecture_docs.length > 0) {
    parts.push(`\n### Architecture`);
    for (const doc of sourceMaterial.architecture_docs) {
      parts.push(`${(doc.content ?? "").slice(0, 4000)}`);
    }
  }

  if (sourceMaterial.grill_resolutions.length > 0) {
    parts.push(`\n### Grill Resolutions`);
    for (const doc of sourceMaterial.grill_resolutions) {
      parts.push(`${(doc.content ?? "").slice(0, 4000)}`);
    }
  }

  // Generated clauses to review
  parts.push(`\n## Generated Clauses to Review (${clauses.length})`);
  for (const c of clauses) {
    parts.push(`\n### ${c.id} — ${c.title} (type: ${c.clause_type}, critical: ${c.critical_path})`);
    parts.push(c.body.slice(0, 1500));
    if (c.acceptance_criteria.length > 0) {
      parts.push(`ACs:`);
      for (const ac of c.acceptance_criteria) {
        parts.push(`  - [${ac.id}] (${ac.verification}) ${ac.text}`);
      }
    }
  }

  parts.push(`\n## Instructions`);
  parts.push(`Review these ${clauses.length} generated clauses against the source material above.`);
  parts.push(`Flag any misalignments, missing grill decisions, scope creep, or quality issues.`);

  return parts.join("\n");
}

// ─── LLM call ───────────────────────────────────────────────────────────────

async function callAlignmentLLM(userMessage: string): Promise<{
  parsed: AlignmentLLMOutput;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  const proxyUrl = process.env.STATION_PROXY_URL ?? "http://127.0.0.1:8095";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "haiku",
        max_tokens: 4096,
        system: ALIGNMENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`station-proxy ${response.status}: ${raw.slice(0, 400)}`);
  }

  let apiResponse: {
    content?: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  try {
    apiResponse = JSON.parse(raw);
  } catch (err) {
    throw new Error(`alignment gate non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`);
  }

  const textBlock = apiResponse.content?.find((c) => c.type === "text");
  const outputText = textBlock?.text ?? "";
  const cleaned = outputText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  const tokens_in = apiResponse.usage?.input_tokens ?? 0;
  const tokens_out = apiResponse.usage?.output_tokens ?? 0;
  // Haiku pricing: $0.80/M in, $4/M out
  const cost_usd = (tokens_in * 0.8 + tokens_out * 4) / 1_000_000;

  let parsed: AlignmentLLMOutput;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`alignment gate JSON parse failed: ${(err as Error).message}: ${cleaned.slice(0, 300)}`);
  }

  return { parsed, tokens_in, tokens_out, cost_usd };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function runAlignmentGate(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauses: ClauseForReview[],
  projectTag: string,
): Promise<AlignmentResult> {
  // Load source material for comparison
  const sourceMaterial = await loadFeatureSourceMaterial(featureId, projectTag);

  // Build review message
  const userMessage = buildAlignmentMessage(
    featureId, featureName, description,
    clauses, sourceMaterial,
  );

  // Call haiku
  const { parsed, tokens_in, tokens_out, cost_usd } = await callAlignmentLLM(userMessage);

  // Normalize output
  const flagged: FlaggedClause[] = (parsed.flagged ?? [])
    .filter((f) => f.clause_id && f.issue && f.severity)
    .map((f) => ({
      clause_id: f.clause_id,
      issue: f.issue,
      severity: f.severity === "blocker" ? "blocker" : "warning",
      suggestion: f.suggestion ?? "",
    }));

  const hasBlockers = flagged.some((f) => f.severity === "blocker");

  return {
    passed: !hasBlockers,
    flagged,
    reasoning: parsed.reasoning ?? "",
    tokens_in,
    tokens_out,
    cost_usd,
  };
}
