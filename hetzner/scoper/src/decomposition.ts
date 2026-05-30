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
import type { FeatureSourceMaterial, SourceMaterialRow } from "./lib/common/source_material.js";
import { MOLD_SIZE, emitPipelineEvent } from "./_shared.js";

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

interface BibleClauseRow {
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
Output ONLY valid JSON (no prose, no markdown fences):
{
  "customer_experience": "Working Backwards: when this feature ships, the user...",
  "clauses": [
    {
      "id": "<EXACT_STUB_ID>",
      "title": "Short imperative title",
      "clause_type": "feature|infrastructure|migration|fix|qa|config|integration",
      "critical_path": true|false,
      "requires": ["<clause_id>", ...],
      "enables": ["<clause_id>", ...],
      "sequence_order": 1,
      "body": "Full clause body: ## Why\\n...\\n## What\\n...\\n## How\\n...\\n## Files\\n...",
      "acceptance_criteria": [
        {
          "id": "AC01",
          "text": "When/Given..., the system...",
          "verification": "auto|physical_qa|kosta_review",
          "form": "ulwick|technical_spec"
        }
      ],
      "contract": {
        "elements": [{"id": "E01", "kind": "endpoint|component|table|migration|edge_fn|cron|interaction", "name": "..."}],
        "exclusions": [{"kind": "...", "name": "what is NOT in scope", "prior": "why excluded"}],
        "antipatterns": [{"id": "AP01", "text": "Do NOT ... because [reason]"}],
        "verification": [{"target": "AC01", "method": "curl|sql|grep|visual|code_check", "command": "actual command", "expect": "expected output"}]
      }
    }
  ]
}

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
  return {
    url: process.env.STATION_PROXY_URL ?? "http://127.0.0.1:8095",
    key: process.env.STATION_PROXY_KEY ?? process.env.NOUS_API_KEY ?? "",
  };
}

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

  let response: Response;
  try {
    response = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": proxy.key },
      body: JSON.stringify({
        model: opts.model,
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
    throw new Error(`station-proxy ${response.status}: ${raw.slice(0, 400)}`);
  }

  let apiResponse: {
    content?: Array<{ type: string; text: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  try {
    apiResponse = JSON.parse(raw);
  } catch (err) {
    throw new Error(`station-proxy non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`);
  }

  const textBlock = apiResponse.content?.find((c) => c.type === "text");
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
  if (sourceMaterial.project_grill_decisions.length > 0) {
    parts.push(`\n## Grill Decisions — Project-Wide (${sourceMaterial.project_grill_decisions.length})`);
    for (const gd of sourceMaterial.project_grill_decisions.slice(0, 20)) {
      parts.push(`- ${gd.source_id}: ${gd.title ?? ""}`);
      if (gd.content) parts.push(`  ${gd.content.slice(0, 300)}`);
    }
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

// ─── Generate mode: injection mold pattern ──────────────────────────────────

async function callSkeletonLLM(
  sourceContext: string,
  prefix: string,
  featureId: string,
  project: string,
): Promise<{ stubs: ClauseStub[]; customer_experience: string; tokens_in: number; tokens_out: number; cost_usd: number }> {
  const userMessage = sourceContext + `\n\n## Instructions\nDecompose this feature into clause STUBS.\nUse clause ID prefix: ${prefix} (e.g., ${prefix}.1, ${prefix}.2, ...)\nFoundation/infrastructure clauses come first (lower sequence_order).\nEvery grill decision must be traceable to at least one clause stub.`;

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
    max_tokens: 16384,
    timeout_ms: 180_000,  // sonnet is 3-5x faster than opus  // opus needs 5min for large features
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

  const userMessage = sourceContext +
    `\n\n## Full Clause Skeleton (all stubs for reference)\n${allStubSection}` +
    prevSection +
    `\n\n## Clause Stubs to Enrich NOW (batch ${batchIndex + 1}/${batchTotal})\n${stubSection}` +
    `\n\n## Instructions\nGenerate FULL clauses with bodies, ACs, and contracts for ONLY the ${batchStubs.length} stubs listed in "Clause Stubs to Enrich NOW".\nDo NOT generate clauses for stubs not in this batch.\nUse the EXACT clause IDs from the stubs.`;

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
    max_tokens: 16384,
    timeout_ms: 180_000,  // sonnet is 3-5x faster than opus
  });

  const cost_usd = (tokens_in * 15 + tokens_out * 75) / 1_000_000;
  let parsed: GenerateLLMOutput;
  try {
    parsed = JSON.parse(text);
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
    throw new Error(`Batch ${batchIndex + 1} JSON parse failed: ${(err as Error).message}: ${text.slice(0, 300)}`);
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
  if (sourceMaterial.grill_count < 4) {
    console.error(`[scoper] generate mode: insufficient grill decisions (${sourceMaterial.grill_count} < 4) for ${featureId}`);
    return {
      customer_experience: draftCustomerExperience(featureName, description),
      preconditions: [],
      clauses: [],
      generated: false,
    };
  }

  const prefix = featureId.includes(".") ? featureId : `${projectTag.toUpperCase()}.${featureId}`;
  const sourceContext = buildSourceContext(featureId, featureName, description, sourceMaterial, projectTag, prefix);

  // ─── Phase 1: Skeleton ────────────────────────────────────────────────────
  const skeleton = await callSkeletonLLM(sourceContext, prefix, featureId, projectTag);
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

  // ─── Phase 2: Batched enrichment (injection mold) ─────────────────────────
  const batches: ClauseStub[][] = [];
  for (let i = 0; i < skeleton.stubs.length; i += MOLD_SIZE) {
    batches.push(skeleton.stubs.slice(i, i + MOLD_SIZE));
  }

  const allClauses: ClauseSpec[] = [];
  const previouslyEnriched: Array<{ id: string; title: string }> = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const result = await callBatchEnrichLLM(
      sourceContext,
      batch,
      skeleton.stubs,
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
      timeout_ms: 130_000,
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
  const rows = (data ?? []) as BibleClauseRow[];
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
