// supabase/functions/scoper/decomposition.ts
// AGT.1.2 + AGT.1.2.A1 — Working Backwards decomposition + Ulwick AC derivation.
//
// THREE GENERATION PATHS:
//
// Generate mode (injection mold pattern):
//   Phase 1 — Skeleton: one opus call produces clause stubs (IDs, titles, deps, briefs)
//   Phase 2 — Batched enrichment: N calls × MOLD_SIZE clauses each → full clauses with ACs + contracts
//   Emits pipeline_events at each phase for carwash live visibility.
//
// Enrich mode: features.clauses has pre-existing IDs → read existing
//   clauses, ENRICH with LLM (ACs, contracts, antipatterns, verification).
//
// AGT.1.2.A1 fix: enrich mode now calls opus to derive proper ACs, contracts,
// and antipatterns instead of producing template ACs mechanically. Mechanical
// deriveACs() is fallback only when LLM is unreachable.

import { getSupabaseClient } from "./lib/common/db.js";
import { costFromTokens, tokensFromResponse } from "./lib/common/cost.js";
import type { AnthropicResponseLike } from "./lib/common/types.js";
import { loadFeatureSourceMaterial } from "./lib/common/source_material.js";
import yaml from "js-yaml";
import type { FeatureSourceMaterial, SourceMaterialRow } from "./lib/common/source_material.js";
import { MOLD_SIZE, emitPipelineEvent } from "./_shared.js";
import { allocateClauseIds, AllocatorUnavailableError } from "./allocator.js";

// ─── Public interfaces (unchanged — plan.ts depends on these) ───────────────

export interface ClauseSpec {
  id: string;
  prefix: string;
  parent_id: string[] | null;
  title: string;
  feature_id: string;
  sequence_order: number;
  maturity_stage: string;
  status: string;
  clause_type: string;
  critical_path: boolean;
  requires: string[];
  enables: string[];
  acceptance_criteria: AcceptanceCriterion[];
  body: string;
  contract?: ClauseContract;
  feature_group?: string;
  parallel_safe_with?: string[];
  // AGT.SCOPER.SEAM_CLAUSE.1 — machine-readable mount point declaration.
  // MANDATORY when clause_type === 'component' (enforced by validateClauseMountTargets).
  // Value is a route path (e.g. "/shifts"), component display name (e.g. "ShiftsBoardChrome"),
  // or CSS selector (e.g. "aside.shifts-board-chrome__sidebar").
  mount_target?: string;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  verification: "auto" | "physical_qa" | "kosta_review";
  form: "ulwick" | "technical_spec";
}

export interface ClauseContract {
  elements: Array<string | { id: string; kind: string; name: string }>;
  exclusions: Array<string | { kind: string; name: string; prior?: string }>;
  antipatterns: Array<string | { id: string; text: string }>;
  verification: Array<{
    target: string;
    method: string;
    command: string;
    expect: string;
  }>;
}

export interface DecompositionOutput {
  customer_experience: string;
  preconditions: string[];
  clauses: ClauseSpec[];
  generated: boolean;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

// ─── Internal types ─────────────────────────────────────────────────────────

export interface BibleClauseRow {
  id: string;
  prefix: string;
  parent_id: string[] | null;
  feature_id: string | null;
  sequence_order: number | null;
  maturity_stage: string | null;
  status: string | null;
  clause_type: string | null;
  critical_path: boolean | null;
  requires: string[] | null;
  enables: string[] | null;
  acceptance_criteria: unknown;
  body: string | null;
  frontmatter: Record<string, unknown> | null;
  contract: ClauseContract | null;
}

interface GrillDecisionRow {
  id: string;
  decision: string;
  rationale: string;
  category: string | null;
  severity: string | null;
}

interface ClauseStub {
  id: string;
  title: string;
  clause_type: string;
  critical_path: boolean;
  requires: string[];
  enables: string[];
  sequence_order: number;
  brief: string;
}

interface SkeletonOutput {
  customer_experience: string;
  clause_stubs: ClauseStub[];
}

interface GenerateLLMOutput {
  customer_experience: string;
  clauses: Array<{
    id: string;
    title: string;
    clause_type: string;
    critical_path: boolean;
    requires: string[];
    enables: string[];
    sequence_order: number;
    body: string;
    acceptance_criteria: AcceptanceCriterion[];
    contract: ClauseContract;
  }>;
}

// ─── System prompts ─────────────────────────────────────────────────────────

const SKELETON_SYSTEM_PROMPT = `You are Scoper, the autonomous planning engine for the NOUS factory pipeline.
You are in SKELETON MODE: produce clause STUBS only — IDs, titles, types, dependencies, and brief descriptions.
NO full bodies, NO ACs, NO contracts. Those come in a follow-up enrichment step.

Output ONLY valid JSON (no prose, no markdown fences):
{
  "customer_experience": "Working Backwards: when this feature ships, the user...",
  "clause_stubs": [
    {
      "id": "<prefix>.<N>",
      "title": "Short imperative title",
      "clause_type": "feature|infrastructure|migration|fix|qa|config|integration",
      "critical_path": true|false,
      "requires": ["<clause_id>", ...],
      "enables": ["<clause_id>", ...],
      "sequence_order": 1,
      "brief": "2-3 sentences: what this clause builds and why"
    }
  ]
}

Rules:
- Use the prefix provided. Number sequentially: PREFIX.1, PREFIX.2, etc.
- Foundation/infrastructure first (lower sequence_order)
- Express dependencies via requires/enables
- critical_path = true if delay blocks the entire feature
- brief must be specific enough to guide full clause generation later
- Every grill decision must be traceable to at least one clause stub
- Right-size: each clause = 1 worker session = 1 PR (~30-60 min for a senior dev)
- customer_experience: MAX 2 sentences. No architecture details.
- brief: MAX 2 sentences per stub. Just what it builds and why — no implementation details.
- Keep total output under 4000 tokens. This is a skeleton, not a spec.`;

const GENERATE_SYSTEM_PROMPT = `You are Scoper, the autonomous planning engine for the NOUS factory pipeline.
You are in BATCH ENRICHMENT MODE: you receive clause STUBS (IDs, titles, briefs) and must produce FULL clauses with bodies, ACs, and contracts.

Each clause is a work unit that a single AI worker (Claude Code agent) will build in one session (~30-60 min). Think of a clause as one PR's worth of work.

## Output Format
Output as markdown documents with YAML frontmatter. Separate each clause with a line containing only ===CLAUSE===.
The FIRST block is metadata (just customer_experience). Each subsequent block is one clause.
The frontmatter (between --- lines) contains structured fields. The body below the frontmatter is free-form markdown.
Do NOT wrap output in code fences. Do NOT output raw JSON or raw YAML.

---
customer_experience: "When this feature ships, the user..."
---

===CLAUSE===

---
id: PREFIX.1
title: "Short imperative title"
clause_type: feature
critical_path: true
requires: []
enables: [PREFIX.2]
sequence_order: 1
acceptance_criteria:
  - id: AC01
    text: "When X happens, the system does Y"
    verification: auto
contract:
  elements:
    - id: E01
      kind: endpoint
      name: "POST /example"
  exclusions:
    - kind: feature
      name: "what is NOT in scope"
      prior: "why excluded"
  antipatterns:
    - id: AP01
      text: "Do NOT do X because reason"
  verification:
    - target: AC01
      method: curl
      command: "curl -s http://localhost:3000/example"
      expect: "200 OK"
---

## Why
One paragraph on why this clause exists and what problem it solves.

## What
Detailed implementation spec. Every step the worker needs to take.

## How
Key technical approach, patterns to follow, libraries to use.

## Files
- path/to/file.ts — what this file does

## Rules
- Use the EXACT clause IDs from the stubs. Do NOT add, remove, or renumber.
- Each clause body MUST have: ## Why, ## What, ## How, ## Files
- 2-8 ACs per clause. "auto" ACs must include concrete verification commands.
- BANNED: "works correctly", "no regressions", "ships when pushed"
- Every grill decision must be reflected in at least one clause body, AC, or antipattern.
- Deferred items go in contract.exclusions.`;

const ENRICHMENT_SYSTEM_PROMPT = `You are Scoper, the autonomous planning engine for the NOUS factory pipeline.
You are in ENRICH MODE: clauses already exist with bodies written by a human planner.
Your job is to enrich each clause with production-grade acceptance criteria, contracts, and antipatterns — NOT to rewrite the clause bodies.

For each clause, you must produce:
1. customer_experience: A Working Backwards statement (1 paragraph).
2. Per clause, acceptance_criteria (2-8 per clause) with proper verification.
3. Per clause, contract object with elements, exclusions, antipatterns, verification.

Output ONLY valid JSON (no prose, no markdown fences):
{
  "customer_experience": "When all of these ship, the user ...",
  "enriched_clauses": [
    {
      "id": "EXACT_CLAUSE_ID",
      "acceptance_criteria": [...],
      "contract": {...}
    }
  ]
}

Rules:
- Use the EXACT clause IDs provided — do not rename or renumber them
- "auto" verification MUST include concrete commands (curl, SQL, grep)
- "physical_qa" for UI rendering, visual layout, UX flow
- "kosta_review" for brand, tone, strategic decisions
- BANNED: generic ACs like "works correctly", "no regressions"
- Minimum 2 ACs per clause, maximum 8
- Antipatterns: invert grill decisions into "Do NOT" statements`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripJsonFences(text: string): string {
  let t = text.trim();
  t = t.replace(/^\s*```(?:json|JSON)?\s*\n?/i, "");
  t = t.replace(/\n?\s*```\s*$/i, "");
  return t.trim();
}

function clauseTitleFromFrontmatter(fm: Record<string, unknown> | null): string {
  if (!fm) return "";
  const t = fm.title;
  return typeof t === "string" ? t : "";
}

function draftCustomerExperience(featureName: string | undefined, description: string | undefined): string {
  const name = (featureName ?? "this feature").trim();
  const desc = (description ?? "").trim();
  if (desc.length > 0) {
    return `When ${name} is shipped, the customer experiences: ${desc}`;
  }
  return `When ${name} is shipped, the customer experiences the outcome stated in the feature spec.`;
}

/**
 * NOUS.IDLOCK.5 — Feature-ID alignment guard (pure helper).
 *
 * Filters bible_clauses rows so only those whose feature_id matches the planning
 * feature (or is NULL — un-claimed legacy row) survive enrichment. AXO.26
 * incident: when an ID collision sent a foreign row into the enrich batch,
 * Scoper silently rewrote another feature's clause. The guard makes the skip
 * loud (console.warn per row) and returns the skipped set so callers can emit
 * a structured pipeline_event.
 *
 * Exported for unit testing.
 */
export function applyAlignmentGuard(
  rows: BibleClauseRow[],
  planningFeatureId: string,
): { kept: BibleClauseRow[]; skipped: Array<{ clause_id: string; row_feature_id: string | null }> } {
  const kept: BibleClauseRow[] = [];
  const skipped: Array<{ clause_id: string; row_feature_id: string | null }> = [];
  for (const r of rows) {
    if (r.feature_id !== null && r.feature_id !== planningFeatureId) {
      skipped.push({ clause_id: r.id, row_feature_id: r.feature_id });
      console.warn(`[scoper] alignment guard: skipping clause ${r.id} — row.feature_id=${r.feature_id} ≠ planning ${planningFeatureId}`);
      continue;
    }
    kept.push(r);
  }
  return { kept, skipped };
}

function derivePreconditions(clauseRows: BibleClauseRow[]): string[] {
  const ids = new Set(clauseRows.map((c) => c.id));
  const roots = clauseRows.filter((c) => {
    const reqs = (c.requires ?? []).filter((r) => ids.has(r));
    return reqs.length === 0;
  });
  if (roots.length === 0) return ["(no foundational clauses identified — review feature scoping)"];
  return roots.map((r) => `${r.id} — ${clauseTitleFromFrontmatter(r.frontmatter) || "(no title)"}`);
}

// ─── LLM call helpers ───────────────────────────────────────────────────────

function getProxyConfig() {
  const directKey = process.env.ANTHROPIC_API_KEY;
  if (directKey) {
    return { url: "https://api.anthropic.com", key: directKey, direct: true };
  }
  return {
    url: process.env.STATION_PROXY_URL ?? "http://127.0.0.1:8095",
    key: process.env.STATION_PROXY_KEY ?? process.env.NOUS_API_KEY ?? "",
    direct: false,
  };
}

const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4-5",
};

async function callLLM(opts: {
  system: string;
  userMessage: string;
  model: "opus" | "sonnet";
  max_tokens: number;
  timeout_ms: number;
}): Promise<{ text: string; tokens_in: number; tokens_out: number }> {
  const proxy = getProxyConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout_ms);

  const resolvedModel = proxy.direct ? (MODEL_MAP[opts.model] ?? opts.model) : opts.model;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": proxy.key,
  };
  if (proxy.direct) headers["anthropic-version"] = "2023-06-01";

  let response: Response;
  try {
    response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: opts.max_tokens,
        system: opts.system,
        messages: [{ role: "user", content: opts.userMessage }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM ${response.status}: ${raw.slice(0, 400)}`);
  }

  let apiResponse: {
    content?: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  try {
    apiResponse = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LLM non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`);
  }

  const textBlock = apiResponse.content?.find((c: { type: string }) => c.type === "text");
  return {
    text: stripJsonFences(textBlock?.text ?? ""),
    tokens_in: apiResponse.usage?.input_tokens ?? 0,
    tokens_out: apiResponse.usage?.output_tokens ?? 0,
  };
}

// ─── Mechanical AC derivation (FALLBACK ONLY) ───────────────────────────────

const ULWICK_RE = /^(when|so that|in order to|user can|customer can|admin can)\b/i;

function inferVerification(text: string, clauseType: string): "auto" | "physical_qa" | "kosta_review" {
  const lower = text.toLowerCase();
  if (/(returns|emits|writes|inserts|column|api|endpoint|status code|http \d|response)/.test(lower)) return "auto";
  if (/(button|click|screen|ui|page renders|toast|hover|drawer|modal)/.test(lower)) return "physical_qa";
  if (/(approve|sign[- ]off|brand|aesthetic|tone|copy)/.test(lower)) return "kosta_review";
  if (clauseType === "ui" || clauseType === "frontend") return "physical_qa";
  if (clauseType === "policy" || clauseType === "decision") return "kosta_review";
  return "auto";
}

function deriveACsMechanical(clause: BibleClauseRow): AcceptanceCriterion[] {
  const raw = clause.acceptance_criteria;
  const list: Array<string | Record<string, unknown>> = Array.isArray(raw) ? (raw as Array<string | Record<string, unknown>>) : [];
  if (list.length === 0) {
    return [{
      id: "AC01",
      text: `${clause.id} ships when the file artifacts described in body are pushed to refs/heads/staging and the build is green.`,
      verification: "auto",
      form: "technical_spec",
    }];
  }
  return list.map((item, i): AcceptanceCriterion => {
    const id = `AC${String(i + 1).padStart(2, "0")}`;
    if (typeof item === "string") {
      const form = ULWICK_RE.test(item) ? "ulwick" : "technical_spec";
      return { id, text: item, verification: inferVerification(item, clause.clause_type ?? ""), form };
    }
    const obj = item as Record<string, unknown>;
    const text = String(obj.text ?? obj.criterion ?? obj.statement ?? `(empty AC ${id})`);
    const explicitVerif = typeof obj.verification === "string" && ["auto", "physical_qa", "kosta_review"].includes(obj.verification as string)
      ? (obj.verification as "auto" | "physical_qa" | "kosta_review")
      : inferVerification(text, clause.clause_type ?? "");
    const explicitForm = obj.form === "ulwick" || obj.form === "technical_spec"
      ? (obj.form as "ulwick" | "technical_spec")
      : (ULWICK_RE.test(text) ? "ulwick" : "technical_spec");
    return {
      id: typeof obj.id === "string" ? obj.id : id,
      text,
      verification: explicitVerif,
      form: explicitForm,
    };
  });
}

// ─── Source material helpers ────────────────────────────────────────────────

async function loadGrillDecisions(featureId: string, project: string): Promise<GrillDecisionRow[]> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("grill_decisions")
    .select("id, decision, rationale, category, severity")
    .or(`feature_id.eq.${featureId},project.eq.${project}`)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`decomposition.loadGrillDecisions: ${error.message}`);
  return (data ?? []) as GrillDecisionRow[];
}

function buildSourceContext(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  sourceMaterial: FeatureSourceMaterial,
  projectTag: string,
  prefix: string,
): string {
  const parts: string[] = [];
  parts.push(`## Feature to Decompose`);
  parts.push(`- ID: ${featureId}\n- Name: ${featureName ?? "(unnamed)"}\n- Project: ${projectTag}\n- Clause ID prefix: ${prefix}\n- Description: ${description ?? "(no description)"}`);

  if (sourceMaterial.grill_decisions.length > 0) {
    parts.push(`\n## Grill Decisions — Feature-Specific (${sourceMaterial.grill_decisions.length})`);
    for (const gd of sourceMaterial.grill_decisions) {
      const sev = gd.severity ? ` [${gd.severity}]` : "";
      const cat = gd.category ? ` (${gd.category})` : "";
      parts.push(`- ${gd.source_id}: ${gd.title ?? ""}${sev}${cat}`);
      if (gd.content) parts.push(`  ${gd.content.slice(0, 600)}`);
    }
  }
  // Only include project-wide decisions when there are NO feature-specific ones.
  // When feature-specific decisions exist, they define the scope — project-wide
  // context causes the LLM to generate clauses for the entire project.
  if (sourceMaterial.project_grill_decisions.length > 0 && sourceMaterial.grill_decisions.length === 0) {
    parts.push(`\n## Grill Decisions — Project-Wide (${sourceMaterial.project_grill_decisions.length})`);
    for (const gd of sourceMaterial.project_grill_decisions.slice(0, 20)) {
      parts.push(`- ${gd.source_id}: ${gd.title ?? ""}`);
      if (gd.content) parts.push(`  ${gd.content.slice(0, 300)}`);
    }
  } else if (sourceMaterial.project_grill_decisions.length > 0) {
    parts.push(`\n_(${sourceMaterial.project_grill_decisions.length} project-wide decisions omitted — feature-specific decisions define scope)_`);
  }
  if (sourceMaterial.architecture_docs.length > 0) {
    parts.push(`\n## Architecture Documents`);
    for (const doc of sourceMaterial.architecture_docs) {
      parts.push(`### ${doc.title ?? "Architecture"}\n${(doc.content ?? "").slice(0, 8000)}`);
    }
  }
  if (sourceMaterial.grill_resolutions.length > 0) {
    parts.push(`\n## Grill Resolution Documents`);
    for (const doc of sourceMaterial.grill_resolutions) {
      parts.push(`### ${doc.title ?? "Resolution"}\n${(doc.content ?? "").slice(0, 6000)}`);
    }
  }
  if (sourceMaterial.prototype_decisions.length > 0) {
    parts.push(`\n## Prototype Decisions`);
    for (const pd of sourceMaterial.prototype_decisions) {
      parts.push(`- ${pd.title ?? pd.source_id}: ${(pd.content ?? "").slice(0, 400)}`);
    }
  }
  return parts.join("\n");
}

interface ShippedClause {
  id: string;
  title: string;
  summary: string; // first ~300 chars of body — enough for LLM to judge overlap
}

async function loadShippedClauses(projectTag: string, clausePrefix: string): Promise<ShippedClause[]> {
  const sb = getSupabaseClient();
  // Extract the project prefix (e.g. "NST" from "NST.feat.1") for filtering
  const projPrefix = clausePrefix.split(".")[0];
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("bible_clauses")
    .select("id, frontmatter, body")
    .eq("prefix", projPrefix)
    .or(`status.eq.shipped,status.eq.build_complete,maturity_stage.eq.SHIPPED`)
    .order("id", { ascending: true });
  if (error) {
    console.error(`[scoper] loadShippedClauses failed: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r: { id: string; frontmatter: Record<string, unknown> | null; body: string | null }) => ({
    id: r.id,
    title: (r.frontmatter?.title as string) || r.id,
    summary: (r.body ?? "").slice(0, 300).replace(/\n/g, " ").trim(),
  }));
}

// ─── Generate mode: injection mold pattern ──────────────────────────────────

async function callSkeletonLLM(
  sourceContext: string,
  prefix: string,
  featureId: string,
  project: string,
  shippedClauses: ShippedClause[] = [],
): Promise<{ stubs: ClauseStub[]; customer_experience: string; tokens_in: number; tokens_out: number; cost_usd: number }> {
  let shippedSection = "";
  if (shippedClauses.length > 0) {
    const shippedList = shippedClauses.slice(0, 100).map(c => {
      const body = c.summary ? ` — ${c.summary}` : "";
      return `- ${c.id}: ${c.title}${body}`;
    }).join("\n");
    shippedSection = `\n\n## Already Shipped (DO NOT regenerate these — they are DONE)\nThe following ${shippedClauses.length} clauses are already built and deployed. Read each summary carefully. Do NOT create stubs that duplicate or overlap with this shipped work — even under a different name.\n\n${shippedList}\n\nIMPORTANT: If the work described in a shipped clause above covers what you're about to generate, SKIP IT. Only generate stubs for genuinely NEW work not covered above.`;
  }
  const userMessage = sourceContext + shippedSection + `\n\n## Instructions\nDecompose this feature into clause STUBS for UNSHIPPED work only.\nUse clause ID prefix: ${prefix} (e.g., ${prefix}.1, ${prefix}.2, ...)\nFoundation/infrastructure clauses come first (lower sequence_order).\nEvery grill decision must be traceable to at least one clause stub.\nSkip any work already covered by the shipped clauses listed above.`;

  await emitPipelineEvent({
    feature_id: featureId,
    project,
    event_type: "scoper.skeleton.start",
    agent: "scoper",
    detail_jsonb: { model: "opus", feature_id: featureId },
  });

  const { text, tokens_in, tokens_out } = await callLLM({
    system: SKELETON_SYSTEM_PROMPT,
    userMessage,
    model: "sonnet",
    max_tokens: 32768,
    timeout_ms: 300_000,  // opus needs 5min for large features
  });

  const cost_usd = (tokens_in * 15 + tokens_out * 75) / 1_000_000;
  let parsed: SkeletonOutput;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Skeleton JSON parse failed: ${(err as Error).message}: ${text.slice(0, 300)}`);
  }

  const stubs = (parsed.clause_stubs ?? []).filter((s) => s.id && s.title);

  await emitPipelineEvent({
    feature_id: featureId,
    project,
    event_type: "scoper.skeleton.complete",
    agent: "scoper",
    detail_jsonb: {
      clause_count: stubs.length,
      clause_ids: stubs.map((s) => s.id),
      mold_size: MOLD_SIZE,
    },
  });

  return { stubs, customer_experience: parsed.customer_experience ?? "", tokens_in, tokens_out, cost_usd };
}

async function callBatchEnrichLLM(
  sourceContext: string,
  batchStubs: ClauseStub[],
  allStubs: ClauseStub[],
  previouslyEnriched: Array<{ id: string; title: string }>,
  batchIndex: number,
  batchTotal: number,
  featureId: string,
  project: string,
): Promise<{ clauses: GenerateLLMOutput["clauses"]; tokens_in: number; tokens_out: number; cost_usd: number }> {
  const stubSection = batchStubs.map((s) =>
    `- ${s.id}: "${s.title}" (${s.clause_type}, critical_path=${s.critical_path})\n  Brief: ${s.brief}\n  Requires: [${s.requires.join(", ")}] Enables: [${s.enables.join(", ")}]`
  ).join("\n");

  const allStubSection = allStubs.map((s) => `- ${s.id}: "${s.title}" (seq=${s.sequence_order})`).join("\n");

  let prevSection = "";
  if (previouslyEnriched.length > 0) {
    prevSection = `\n## Previously Generated Clauses (for coherence — do NOT regenerate)\n` +
      previouslyEnriched.map((p) => `- ${p.id}: "${p.title}"`).join("\n");
  }

  // Lean context: stubs carry the grill intent from skeleton phase.
  // No need to resend full grill decisions + architecture for enrichment.
  const userMessage = `## Feature Context
- Feature ID: ${featureId}
- Project: ${project}

## Full Clause Skeleton (all stubs for reference)
${allStubSection}` +
    prevSection +
    `\n\n## Clause Stubs to Enrich NOW (batch ${batchIndex + 1}/${batchTotal})
${stubSection}

## Instructions
Generate FULL clauses with bodies, ACs, and contracts for ONLY the ${batchStubs.length} stubs listed above.
Do NOT generate clauses for stubs not in this batch.
Use the EXACT clause IDs from the stubs.
Each clause body must have: ## Why, ## What, ## How, ## Files.
2-8 ACs per clause with concrete verification commands.`;

  await emitPipelineEvent({
    feature_id: featureId,
    project,
    event_type: "scoper.batch.start",
    agent: "scoper",
    detail_jsonb: {
      batch_index: batchIndex,
      batch_total: batchTotal,
      clause_titles: batchStubs.map((s) => s.title),
    },
  });

  const batchStart = Date.now();
  const { text, tokens_in, tokens_out } = await callLLM({
    system: GENERATE_SYSTEM_PROMPT,
    userMessage,
    model: "sonnet",
    max_tokens: 32768,
    timeout_ms: 300_000,
  });

  const cost_usd = (tokens_in * 15 + tokens_out * 75) / 1_000_000;
  let parsed: GenerateLLMOutput = { customer_experience: "", clauses: [] };
  try {
    // Markdown+frontmatter parser: split on ===CLAUSE===, parse each block
    const cleaned = text.replace(/^\s*```[\w]*\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "").trim();

    // JSON fallback: if entire output is JSON, parse directly
    if (cleaned.startsWith("{")) {
      parsed = JSON.parse(cleaned);
    } else {
      const blocks = cleaned.split(/\n*===CLAUSE===\n*/);
      let customerExperience = "";
      const clauses: GenerateLLMOutput["clauses"] = [];

      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;

        // Extract frontmatter between --- delimiters
        const fmMatch = trimmed.match(/^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
        if (!fmMatch) continue;

        const frontmatterText = fmMatch[1];
        const bodyText = (fmMatch[2] || "").trim();

        // Parse frontmatter YAML (short, structured — safe for yaml.load)
        let fm: Record<string, unknown>;
        try {
          fm = yaml.load(frontmatterText) as Record<string, unknown>;
        } catch (yamlErr) {
          console.warn(`[scoper] frontmatter parse failed, skipping block: ${(yamlErr as Error).message}`);
          continue;
        }

        if (!fm || typeof fm !== "object") continue;

        // Metadata block: customer_experience only
        if ("customer_experience" in fm && !("id" in fm)) {
          customerExperience = fm.customer_experience as string;
          continue;
        }

        // Clause block: structured frontmatter + markdown body
        if ("id" in fm) {
          clauses.push({
            ...fm,
            body: bodyText || (fm.body as string) || "",
          } as GenerateLLMOutput["clauses"][0]);
        }
      }

      parsed = { customer_experience: customerExperience, clauses };
    }
  } catch (err) {
    await emitPipelineEvent({
      feature_id: featureId,
      project,
      event_type: "scoper.batch.error",
      agent: "scoper",
      severity: "error",
      detail_jsonb: {
        batch_index: batchIndex,
        error: (err as Error).message,
        clause_titles: batchStubs.map((s) => s.title),
      },
    });
    throw new Error(`Batch ${batchIndex + 1} parse failed: ${(err as Error).message}: ${text.slice(0, 300)}`);
  }

  await emitPipelineEvent({
    feature_id: featureId,
    project,
    event_type: "scoper.batch.complete",
    agent: "scoper",
    detail_jsonb: {
      batch_index: batchIndex,
      clauses_enriched: parsed.clauses?.length ?? 0,
      duration_s: Math.round((Date.now() - batchStart) / 1000),
    },
  });

  return { clauses: parsed.clauses ?? [], tokens_in, tokens_out, cost_usd };
}

function validateClause(gc: GenerateLLMOutput["clauses"][0], prefix: string): ClauseSpec | null {
  if (!gc.id || !gc.body) return null;
  const validACs: AcceptanceCriterion[] = (gc.acceptance_criteria ?? [])
    .filter((ac) => ac.text && ac.verification && ac.form)
    .map((ac, i) => ({
      id: ac.id || `AC${String(i + 1).padStart(2, "0")}`,
      text: ac.text,
      verification: (["auto", "physical_qa", "kosta_review"].includes(ac.verification)
        ? ac.verification : "auto") as "auto" | "physical_qa" | "kosta_review",
      form: (ac.form === "ulwick" || ac.form === "technical_spec"
        ? ac.form : "technical_spec") as "ulwick" | "technical_spec",
    }));

  // Ensure minimum 2 ACs
  while (validACs.length < 2) {
    validACs.push({
      id: `AC${String(validACs.length + 1).padStart(2, "0")}`,
      text: validACs.length === 0
        ? `${gc.id} artifacts are committed to refs/heads/staging and build is green.`
        : `${gc.id} implementation matches the clause body specification.`,
      verification: "auto",
      form: "technical_spec",
    });
  }

  const contract: ClauseContract = {
    elements: Array.isArray(gc.contract?.elements) ? gc.contract.elements : [],
    exclusions: Array.isArray(gc.contract?.exclusions) ? gc.contract.exclusions : [],
    antipatterns: Array.isArray(gc.contract?.antipatterns) ? gc.contract.antipatterns : [],
    verification: Array.isArray(gc.contract?.verification) ? gc.contract.verification : [],
  };

  return {
    id: gc.id,
    prefix: gc.id.split(".").slice(0, -1).join(".") || prefix,
    parent_id: null,
    title: gc.title || gc.id,
    feature_id: "", // set by caller
    sequence_order: gc.sequence_order ?? 0,
    maturity_stage: "SCAFFOLD",
    status: "draft",
    clause_type: gc.clause_type || "feature",
    critical_path: gc.critical_path ?? false,
    requires: (gc.requires ?? []).filter((r) => typeof r === "string"),
    enables: (gc.enables ?? []).filter((e) => typeof e === "string"),
    acceptance_criteria: validACs,
    body: gc.body,
    contract,
  };
}

async function generateClausesFromSource(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  projectTag: string,
): Promise<DecompositionOutput> {
  const sourceMaterial = await loadFeatureSourceMaterial(featureId, projectTag);
  // Scope check: warn if grill decisions span too many distinct sources (likely needs splitting)
  // Filter to only this feature's grill decisions for scope check (not other features' decisions that share the project)
  const featureSpecificGrills = sourceMaterial.grill_decisions.filter(g => g.feature_id === featureId || g.feature_id === null);
  const distinctSources = new Set(featureSpecificGrills.map(g => g.source_id?.split("-")[0] || "unknown"));
  if (distinctSources.size > 4) {
    console.warn(`[scoper] scope warning: ${featureId} has grill decisions from ${distinctSources.size} distinct sources — consider splitting into multiple features`);
    await emitPipelineEvent({
      feature_id: featureId, project: projectTag,
      event_type: "scoper.scope.warning", agent: "scoper", severity: "warn",
      detail_jsonb: { distinct_sources: distinctSources.size, message: "Feature may be too broad — consider splitting" },
    });
  }

  if (sourceMaterial.grill_count < 4) {
    console.error(`[scoper] generate mode: insufficient grill decisions (${sourceMaterial.grill_count} < 4) for ${featureId}`);
    return {
      customer_experience: draftCustomerExperience(featureName, description),
      preconditions: [],
      clauses: [],
      generated: false,
    };
  }

  // NST.96.2: Read clause_prefix from nous.projects — canonical source for project identity
  let prefix: string;
  if (featureId.includes(".")) {
    prefix = featureId;
  } else {
    const sb = getSupabaseClient();
    const { data: projRow } = await (sb as any)
      .from("projects")
      .select("clause_prefix")
      .eq("tag", projectTag)
      .maybeSingle();
    prefix = projRow?.clause_prefix
      ? `${projRow.clause_prefix}.${featureId}`
      : `${projectTag.toUpperCase()}.${featureId}`;
  }
  const sourceContext = buildSourceContext(featureId, featureName, description, sourceMaterial, projectTag, prefix);

  // Load shipped clauses scoped to this project so skeleton doesn't regenerate completed work
  const shippedClauses = await loadShippedClauses(projectTag, prefix);

  // ─── Phase 1: Skeleton ────────────────────────────────────────────────────
  const skeleton = await callSkeletonLLM(sourceContext, prefix, featureId, projectTag, shippedClauses);
  let totalTokensIn = skeleton.tokens_in;
  let totalTokensOut = skeleton.tokens_out;
  let totalCost = skeleton.cost_usd;

  if (skeleton.stubs.length === 0) {
    return {
      customer_experience: skeleton.customer_experience || draftCustomerExperience(featureName, description),
      preconditions: [],
      clauses: [],
      generated: true,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_usd: totalCost,
    };
  }

  // ─── Phase 1b: Allocate real clause IDs via nous.allocate_clause_ids ──────
  // NOUS.IDLOCK.5: the skeleton LLM produces stub IDs locally (PREFIX.1..N)
  // for in-batch reference, but these are NOT authoritative. Mint real IDs
  // from the DB allocator (advisory-lock, full ID-space scan including
  // shipped/retired tombstones) and rewrite every stub id + requires + enables
  // reference to use the allocated IDs.
  //
  // Per clause body: allocator unavailability is a FATAL halt — there is no
  // local fallback by design.
  let allocation: Awaited<ReturnType<typeof allocateClauseIds>>;
  try {
    allocation = await allocateClauseIds(featureId, prefix, skeleton.stubs.length);
  } catch (err) {
    await emitPipelineEvent({
      feature_id: featureId, project: projectTag,
      event_type: "scoper.allocator.unavailable", agent: "scoper", severity: "error",
      detail_jsonb: {
        error: (err as Error).message,
        requested_count: skeleton.stubs.length,
        prefix,
      },
    });
    throw err;
  }

  const idMap = new Map<string, string>();
  const usableStubs: ClauseStub[] = [];
  const skippedPlaceholders: Array<{ stub_id: string; allocated_id: string; reason?: string }> = [];
  for (let i = 0; i < skeleton.stubs.length; i++) {
    const stub = skeleton.stubs[i];
    const slot = allocation.slots[i];
    if (!slot) {
      // Allocator returned fewer slots than requested — surface as fatal.
      throw new AllocatorUnavailableError(
        `requested ${skeleton.stubs.length} IDs, got ${allocation.slots.length}`,
      );
    }
    if (slot.is_placeholder) {
      skippedPlaceholders.push({ stub_id: stub.id, allocated_id: slot.id, reason: slot.reason });
      continue;
    }
    idMap.set(stub.id, slot.id);
    usableStubs.push(stub);
  }

  if (skippedPlaceholders.length > 0) {
    console.warn(`[scoper] allocator returned ${skippedPlaceholders.length} placeholder slot(s) — skipping`);
    await emitPipelineEvent({
      feature_id: featureId, project: projectTag,
      event_type: "scoper.allocator.placeholders_skipped", agent: "scoper", severity: "warn",
      detail_jsonb: { skipped: skippedPlaceholders },
    });
  }

  // Rewrite every stub id + dependency reference to use allocated IDs.
  // Internal references that target a skipped (placeholder) stub are dropped
  // from requires/enables — the dependency never made it into the dispatch tree.
  const remappedStubs: ClauseStub[] = usableStubs.map((s) => ({
    ...s,
    id: idMap.get(s.id)!,
    requires: (s.requires ?? []).map((r) => idMap.get(r)).filter((r): r is string => !!r),
    enables: (s.enables ?? []).map((e) => idMap.get(e)).filter((e): e is string => !!e),
  }));

  if (remappedStubs.length === 0) {
    await emitPipelineEvent({
      feature_id: featureId, project: projectTag,
      event_type: "scoper.allocator.all_placeholders", agent: "scoper", severity: "warn",
      detail_jsonb: { requested: skeleton.stubs.length },
    });
    return {
      customer_experience: skeleton.customer_experience || draftCustomerExperience(featureName, description),
      preconditions: [],
      clauses: [],
      generated: true,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_usd: totalCost,
    };
  }

  // ─── Phase 2: Batched enrichment (injection mold) ─────────────────────────
  const batches: ClauseStub[][] = [];
  for (let i = 0; i < remappedStubs.length; i += MOLD_SIZE) {
    batches.push(remappedStubs.slice(i, i + MOLD_SIZE));
  }

  const allClauses: ClauseSpec[] = [];
  const previouslyEnriched: Array<{ id: string; title: string }> = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    try {
      const result = await callBatchEnrichLLM(
        sourceContext,
        batch,
        remappedStubs,
        previouslyEnriched,
        bi,
        batches.length,
        featureId,
        projectTag,
      );

      totalTokensIn += result.tokens_in;
      totalTokensOut += result.tokens_out;
      totalCost += result.cost_usd;

      for (const gc of result.clauses) {
        const clause = validateClause(gc, prefix);
        if (clause) {
          clause.feature_id = featureId;
          allClauses.push(clause);
          previouslyEnriched.push({ id: clause.id, title: clause.title });
        }
      }
    } catch (batchErr) {
      // Non-fatal: log error, skip this batch, continue with remaining
      console.error(`[scoper] batch ${bi} failed (non-fatal, continuing): ${(batchErr as Error).message}`);
      await emitPipelineEvent({
        feature_id: featureId, project: projectTag,
        event_type: "scoper.batch.error", agent: "scoper", severity: "error",
        detail_jsonb: { batch_index: bi, error: (batchErr as Error).message, clause_titles: batch.map(s => s.title) },
      });
      // Continue — don't lose clauses from previous successful batches
    }
  }

  allClauses.sort((a, b) => a.sequence_order - b.sequence_order);
  const preconditions = allClauses
    .filter((c) => c.requires.length === 0)
    .map((c) => `${c.id} — ${c.title}`);

  return {
    customer_experience: skeleton.customer_experience || draftCustomerExperience(featureName, description),
    preconditions,
    clauses: allClauses,
    generated: true,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost_usd: totalCost,
  };
}

// ─── Enrich mode (unchanged — enriches existing clauses) ────────────────────

interface EnrichmentLLMOutput {
  customer_experience: string;
  enriched_clauses: Array<{
    id: string;
    acceptance_criteria: AcceptanceCriterion[];
    contract: ClauseContract;
  }>;
}

function buildEnrichmentMessage(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauses: BibleClauseRow[],
  grillDecisions: GrillDecisionRow[],
  architectureDoc: string | null,
  projectTag: string,
): string {
  const parts: string[] = [];
  parts.push(`## Feature\n- ID: ${featureId}\n- Name: ${featureName ?? "(unnamed)"}\n- Project: ${projectTag}\n- Description: ${description ?? "(no description)"}`);
  if (grillDecisions.length > 0) {
    parts.push(`\n## Grill Decisions (${grillDecisions.length} resolved)`);
    for (const gd of grillDecisions) {
      const sev = gd.severity ? ` [${gd.severity}]` : "";
      const cat = gd.category ? ` (${gd.category})` : "";
      parts.push(`- ${gd.id}: ${gd.decision}${sev}${cat}\n  Rationale: ${gd.rationale}`);
    }
  }
  if (architectureDoc) {
    const maxArchLen = 8000;
    const archText = architectureDoc.length > maxArchLen ? architectureDoc.slice(0, maxArchLen) + "\n... (truncated)" : architectureDoc;
    parts.push(`\n## Architecture Document\n${archText}`);
  }
  parts.push(`\n## Existing Clauses to Enrich (${clauses.length})`);
  for (const c of clauses) {
    const title = clauseTitleFromFrontmatter(c.frontmatter) || c.id;
    const bodyPreview = (c.body ?? "").slice(0, 2000);
    parts.push(`\n### ${c.id} — ${title} (type: ${c.clause_type ?? "feature"}, critical_path: ${c.critical_path ?? false})`);
    parts.push(bodyPreview);
  }
  parts.push(`\n## Instructions\nEnrich each clause above with ACs, contracts, and a customer_experience statement.\nUse the EXACT clause IDs shown above.`);
  return parts.join("\n");
}

async function enrichWithLLM(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseRows: BibleClauseRow[],
  architectureDoc: string | null,
  projectTag: string,
): Promise<{
  customer_experience: string;
  enrichments: Map<string, { acceptance_criteria: AcceptanceCriterion[]; contract: ClauseContract }>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  const grillDecisions = await loadGrillDecisions(featureId, projectTag);
  const MAX_BATCH = 12;
  let allTokensIn = 0, allTokensOut = 0, allCost = 0;
  let customerExperience = "";
  const enrichments = new Map<string, { acceptance_criteria: AcceptanceCriterion[]; contract: ClauseContract }>();

  for (let offset = 0; offset < clauseRows.length; offset += MAX_BATCH) {
    const batch = clauseRows.slice(offset, offset + MAX_BATCH);
    const userMessage = buildEnrichmentMessage(featureId, featureName, description, batch, grillDecisions, architectureDoc, projectTag);

    const { text, tokens_in, tokens_out } = await callLLM({
      system: ENRICHMENT_SYSTEM_PROMPT,
      userMessage,
      model: "sonnet",
      max_tokens: 8192,
      timeout_ms: 300_000,
    });

    const cost_usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000;
    allTokensIn += tokens_in;
    allTokensOut += tokens_out;
    allCost += cost_usd;

    let parsed: EnrichmentLLMOutput;
    try { parsed = JSON.parse(text); } catch (err) {
      throw new Error(`Enrichment JSON parse failed: ${(err as Error).message}: ${text.slice(0, 300)}`);
    }

    if (offset === 0) customerExperience = parsed.customer_experience;

    for (const ec of parsed.enriched_clauses) {
      if (!ec.id || !Array.isArray(ec.acceptance_criteria) || !ec.contract) continue;
      const validACs = ec.acceptance_criteria
        .filter((ac) => ac.text && ac.verification && ac.form)
        .map((ac, i) => ({
          id: ac.id || `AC${String(i + 1).padStart(2, "0")}`,
          text: ac.text,
          verification: (["auto", "physical_qa", "kosta_review"].includes(ac.verification) ? ac.verification : "auto") as "auto" | "physical_qa" | "kosta_review",
          form: (ac.form === "ulwick" || ac.form === "technical_spec" ? ac.form : "technical_spec") as "ulwick" | "technical_spec",
        }));
      const contract: ClauseContract = {
        elements: Array.isArray(ec.contract.elements) ? ec.contract.elements : [],
        exclusions: Array.isArray(ec.contract.exclusions) ? ec.contract.exclusions : [],
        antipatterns: Array.isArray(ec.contract.antipatterns) ? ec.contract.antipatterns : [],
        verification: Array.isArray(ec.contract.verification) ? ec.contract.verification : [],
      };
      if (validACs.length >= 2) enrichments.set(ec.id, { acceptance_criteria: validACs, contract });
    }
  }
  return { customer_experience: customerExperience, enrichments, tokens_in: allTokensIn, tokens_out: allTokensOut, cost_usd: allCost };
}

async function enrichExistingClauses(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseIds: string[],
  opts?: { architectureDoc?: string | null; projectTag?: string; sessionId?: string },
): Promise<DecompositionOutput> {
  if (clauseIds.length === 0) {
    return { customer_experience: draftCustomerExperience(featureName, description), preconditions: [], clauses: [], generated: false };
  }

  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("bible_clauses")
    .select("id, prefix, parent_id, feature_id, sequence_order, maturity_stage, status, clause_type, critical_path, requires, enables, acceptance_criteria, body, frontmatter, contract")
    .in("id", clauseIds);
  if (error) throw new Error(`decomposition.enrichExistingClauses: ${error.message}`);
  const allRows = (data ?? []) as BibleClauseRow[];

  // NOUS.IDLOCK.5: Feature-ID alignment guard. Foreign rows are filtered here;
  // applyAlignmentGuard logs the structured warning so the helper stays pure
  // and unit-testable.
  const { kept: rows, skipped: aligned_skipped } = applyAlignmentGuard(allRows, featureId);
  if (aligned_skipped.length > 0 && opts?.projectTag) {
    await emitPipelineEvent({
      feature_id: featureId, project: opts.projectTag,
      event_type: "scoper.alignment.feature_id_mismatch", agent: "scoper", severity: "warn",
      detail_jsonb: { skipped_clauses: aligned_skipped, planning_feature_id: featureId },
    });
  }

  const preconditions = derivePreconditions(rows);

  let llmCustomerExperience: string | null = null;
  let llmEnrichments: Map<string, { acceptance_criteria: AcceptanceCriterion[]; contract: ClauseContract }> | null = null;
  let enrichTokensIn = 0, enrichTokensOut = 0, enrichCost = 0;
  let enriched = false;

  if (opts?.projectTag) {
    try {
      const result = await enrichWithLLM(featureId, featureName, description, rows, opts.architectureDoc ?? null, opts.projectTag);
      llmCustomerExperience = result.customer_experience;
      llmEnrichments = result.enrichments;
      enrichTokensIn = result.tokens_in;
      enrichTokensOut = result.tokens_out;
      enrichCost = result.cost_usd;
      enriched = true;
    } catch (err) {
      console.error(`[scoper] enrichment LLM failed, falling back to mechanical: ${(err as Error).message}`);
    }
  }

  const customer_experience = llmCustomerExperience ?? draftCustomerExperience(featureName, description);
  const clauses: ClauseSpec[] = rows.map((r) => {
    const enrichment = llmEnrichments?.get(r.id);
    return {
      id: r.id,
      prefix: r.prefix,
      parent_id: r.parent_id,
      title: clauseTitleFromFrontmatter(r.frontmatter) || r.id,
      feature_id: r.feature_id ?? featureId,
      sequence_order: r.sequence_order ?? 0,
      maturity_stage: r.maturity_stage ?? "SCAFFOLD",
      status: r.status ?? "active",
      clause_type: r.clause_type ?? "feature",
      critical_path: r.critical_path ?? false,
      requires: (r.requires ?? []).filter((x) => typeof x === "string"),
      enables: (r.enables ?? []).filter((x) => typeof x === "string"),
      acceptance_criteria: enrichment?.acceptance_criteria ?? deriveACsMechanical(r),
      body: r.body ?? "",
      contract: enrichment?.contract ?? r.contract ?? undefined,
    };
  });
  clauses.sort((a, b) => {
    if (a.sequence_order !== b.sequence_order) return a.sequence_order - b.sequence_order;
    return a.id.localeCompare(b.id);
  });

  return {
    customer_experience,
    preconditions,
    clauses,
    generated: false,
    tokens_in: enriched ? enrichTokensIn : undefined,
    tokens_out: enriched ? enrichTokensOut : undefined,
    cost_usd: enriched ? enrichCost : undefined,
  };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export async function decomposeFeature(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseIds: string[],
  opts?: { architectureDoc?: string | null; projectTag?: string; sessionId?: string },
): Promise<DecompositionOutput> {
  if (clauseIds.length === 0 && opts?.projectTag) {
    console.log(`[scoper] generate mode (injection mold): ${featureId} has no clauses, generating from source material`);
    return await generateClausesFromSource(featureId, featureName, description, opts.projectTag);
  }
  return await enrichExistingClauses(featureId, featureName, description, clauseIds, opts);
}
