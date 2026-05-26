// supabase/functions/scoper/decomposition.ts
// AGT.1.2 — Working Backwards decomposition + Ulwick AC derivation.
//
// TWO MODES:
//   Generate mode: features.clauses is empty → LLM generates clauses from
//     grill decisions + architecture doc + feature description via opus.
//   Enrich mode: features.clauses has pre-existing IDs → read existing
//     clauses, enrich ACs (original behavior, preserved).
//
// Grill decision: decomposition.ts LLM rewrite (2026-05-26, memory 031e6de3)
//   - Full context to opus, no truncation
//   - Scoper assigns clause IDs sequentially after LLM output
//   - Re-run = regenerate + mark old clauses superseded
//   - LLM derives antipatterns from grill decisions (inline-text)
//   - LLM generates full contracts (elements, exclusions, antipatterns, verification)
//   - Station-proxy for LLM calls (same pattern as Sentinel)

import { getSupabaseClient } from "../_common/db.ts";
import { costFromTokens, tokensFromResponse } from "../_common/cost.ts";
import type { AnthropicResponseLike } from "../_common/types.ts";

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
  // Wave-organization fields (populated downstream by waves.ts)
  feature_group?: string;
  parallel_safe_with?: string[];
}

export interface AcceptanceCriterion {
  id: string;             // e.g. "AC01"
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

// ─── Internal row types ─────────────────────────────────────────────────────

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

// ─── LLM system prompt ─────────────────────────────────────────────────────

const DECOMPOSITION_SYSTEM_PROMPT = `You are Scoper, the autonomous planning engine for the NOUS factory pipeline.
Your job: receive a feature description, grill decisions, and architecture doc — then perform
Working Backwards decomposition to generate bible clauses.

Working Backwards: start from the customer experience (what the user sees when this ships),
derive preconditions (what must be true for that experience to exist), then derive clauses
(units of work) for each precondition.

Each clause you generate must include:
1. A descriptive title (imperative, e.g. "Build the dispatch retry handler")
2. A clause_type: one of "feature", "implementation", "migration", "bugfix", "ui", "infrastructure", "integration"
3. Whether it's critical_path (true if downstream clauses depend on it or if the feature can't ship without it)
4. requires: IDs of other clauses this one depends on (use PLACEHOLDER IDs like "C1", "C2" — they'll be replaced)
5. enables: IDs of clauses this one unblocks
6. A body: the detailed spec of what to build (3-15 lines, specific enough that a cold-start worker can build it)
7. acceptance_criteria: array of ACs in this format:
   { "id": "AC01", "text": "...", "verification": "auto|physical_qa|kosta_review", "form": "ulwick|technical_spec" }
   - Use "ulwick" form for user-facing outcomes ("When X, the user can Y so that Z")
   - Use "technical_spec" form for plumbing ("Endpoint returns 200 with schema {...}")
   - verification: "auto" for things testable by curl/grep/sql, "physical_qa" for UI, "kosta_review" for brand/tone
8. contract: the full verification contract:
   {
     "elements": [{"id": "E01", "kind": "endpoint|component|table|interaction|side_effect", "name": "..."}],
     "exclusions": [{"id": "X01", "kind": "...", "name": "...", "prior": "reason not in scope"}],
     "antipatterns": [{"id": "AP01", "text": "Do NOT ..."}],
     "verification": [{"target": "E01|X01|AC01", "method": "curl|sql|visual|code_check|e2e", "command": "...", "expect": "..."}]
   }
   Derive antipatterns from the grill decisions — invert each decision into what NOT to do.
   Verification commands must be concrete: actual curl commands, SQL queries, grep patterns.

Output ONLY valid JSON in this exact shape (no prose, no markdown fences):
{
  "customer_experience": "When this feature ships, ...",
  "preconditions": ["Precondition 1", "Precondition 2"],
  "clauses": [
    {
      "placeholder_id": "C1",
      "title": "...",
      "clause_type": "...",
      "critical_path": true|false,
      "requires": [],
      "enables": ["C2"],
      "body": "...",
      "acceptance_criteria": [...],
      "contract": {...}
    }
  ]
}

Rules:
- Minimum 1 clause, maximum 12 per feature. If more are needed, the feature should be split.
- Order clauses by dependency: foundations first, UI last.
- Every element in contract.elements must have a matching verification entry.
- Every exclusion must have a matching verification entry (method: code_check, expect: "no matches").
- Keep bodies specific to THIS project's stack and conventions from the architecture doc.
- Do NOT invent requirements not covered by the grill decisions or feature description.
- If a grill decision defers something, add it to exclusions, not elements.`;

// ─── Few-shot contract example (injected into user message) ─────────────────

const CONTRACT_EXAMPLE = `Example contract from a real clause (NST.28):
{
  "elements": [
    {"id": "E01", "kind": "table", "name": "nous.punch_list_items"},
    {"id": "E02", "kind": "component", "name": "capture overlay"},
    {"id": "E03", "kind": "component", "name": "clause drawer tab"},
    {"id": "E04", "kind": "interaction", "name": "badge count"},
    {"id": "E05", "kind": "endpoint", "name": "API endpoint /nous/punch-list"}
  ],
  "exclusions": [
    {"kind": "display", "name": "Gate telemetry display", "prior": "stays on Factory Inspector"},
    {"kind": "infra", "name": "Screenshot hosting infra", "prior": "use existing Supabase storage"}
  ],
  "antipatterns": [
    {"id": "AP01", "text": "Do NOT build custom screenshot storage — use existing Supabase storage bucket"}
  ],
  "verification": [
    {"target": "X01", "method": "code_check", "command": "grep -r telemetry src/components/PunchList", "expect": "no matches"},
    {"target": "E01", "method": "sql", "command": "SELECT * FROM nous.punch_list_items LIMIT 1", "expect": "table exists with expected columns"},
    {"target": "E05", "method": "curl", "command": "curl /nous/punch-list?clause_id=X", "expect": "200 with items array"}
  ]
}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

function sha256Hex(text: string): string {
  // Deno built-in crypto
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  // Sync hash via SubtleCrypto is not available; use a simple deterministic hash.
  // In Deno, we can use the crypto API.
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

async function sha256HexAsync(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Enrich mode: existing behavior for pre-existing clauses ────────────────

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

function deriveACs(clause: BibleClauseRow): AcceptanceCriterion[] {
  const raw = clause.acceptance_criteria;
  const list: Array<string | Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<string | Record<string, unknown>>)
    : [];

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
    const explicitVerif =
      typeof obj.verification === "string" &&
      ["auto", "physical_qa", "kosta_review"].includes(obj.verification as string)
        ? (obj.verification as "auto" | "physical_qa" | "kosta_review")
        : inferVerification(text, clause.clause_type ?? "");
    const explicitForm =
      obj.form === "ulwick" || obj.form === "technical_spec"
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

function clauseTitleFromFrontmatter(fm: Record<string, unknown> | null): string {
  if (!fm) return "";
  const t = fm.title;
  return typeof t === "string" ? t : "";
}

// ─── Enrich mode: read existing clauses from DB ─────────────────────────────

async function enrichExistingClauses(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseIds: string[],
): Promise<DecompositionOutput> {
  const customer_experience = draftCustomerExperience(featureName, description);

  if (clauseIds.length === 0) {
    return { customer_experience, preconditions: [], clauses: [], generated: false };
  }

  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("bible_clauses")
    .select(
      "id, prefix, parent_id, feature_id, sequence_order, maturity_stage, status, clause_type, critical_path, requires, enables, acceptance_criteria, body, frontmatter, contract",
    )
    .in("id", clauseIds);
  if (error) {
    throw new Error(`decomposition.enrichExistingClauses: ${error.message}`);
  }
  const rows = (data ?? []) as BibleClauseRow[];

  const preconditions = derivePreconditions(rows);

  const clauses: ClauseSpec[] = rows.map((r) => ({
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
    acceptance_criteria: deriveACs(r),
    body: r.body ?? "",
    contract: r.contract ?? undefined,
  }));

  clauses.sort((a, b) => {
    if (a.sequence_order !== b.sequence_order) return a.sequence_order - b.sequence_order;
    return a.id.localeCompare(b.id);
  });

  return { customer_experience, preconditions, clauses, generated: false };
}

// ─── Customer experience drafting ───────────────────────────────────────────

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

// ─── Generate mode: LLM-powered clause creation ────────────────────────────

async function loadGrillDecisions(featureId: string, project: string): Promise<GrillDecisionRow[]> {
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("grill_decisions")
    .select("id, decision, rationale, category, severity")
    .or(`feature_id.eq.${featureId},project.eq.${project}`)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`decomposition.loadGrillDecisions: ${error.message}`);
  }
  return (data ?? []) as GrillDecisionRow[];
}

async function resolvePrefix(project: string): Promise<string> {
  const sb = getSupabaseClient();
  // Try to find an existing clause's prefix for this project
  // deno-lint-ignore no-explicit-any
  const { data } = await (sb as any)
    .from("bible_clauses")
    .select("prefix")
    .eq("feature_id", project)
    .limit(1);
  if (data && data.length > 0) return data[0].prefix;

  // Fall back: derive from project tag
  // "nous-station" → "NST", "nous-agents" → "AGT", "catering" → "CAT"
  const TAG_PREFIX_MAP: Record<string, string> = {
    "nous-station": "NST",
    "nous-agents": "AGT",
    "catering": "CAT",
    "mise": "MISE",
    "sidework": "SDW",
    "axio": "AXO",
    "paideia": "PAI",
    "solid": "SOL",
    "pliromi": "PLR",
    "themelio": "THM",
    "ergotaxia": "ERG",
    "ovation": "OVA",
    "toll-router": "TLR",
    "pesto": "PST",
    "kaei": "KAEI",
  };
  return TAG_PREFIX_MAP[project] ?? project.toUpperCase().slice(0, 3);
}

async function getNextSequence(prefix: string, featureId: string): Promise<number> {
  const sb = getSupabaseClient();
  // Find the feature's numeric suffix to build clause IDs like NST.88.1, NST.88.2
  // Extract the feature number from featureId (e.g. "NST.88" → 88)
  const featureMatch = featureId.match(/\.(\d+)$/);
  const featureNum = featureMatch ? featureMatch[1] : featureId;
  const idPattern = `${prefix}.${featureNum}.%`;

  // deno-lint-ignore no-explicit-any
  const { data } = await (sb as any)
    .from("bible_clauses")
    .select("id")
    .like("id", idPattern)
    .order("id", { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    // Extract the last number: "NST.88.3" → 3
    const lastId = data[0].id as string;
    const parts = lastId.split(".");
    const lastNum = parseInt(parts[parts.length - 1], 10);
    return isNaN(lastNum) ? 1 : lastNum + 1;
  }
  return 1;
}

interface LLMClauseOutput {
  placeholder_id: string;
  title: string;
  clause_type: string;
  critical_path: boolean;
  requires: string[];
  enables: string[];
  body: string;
  acceptance_criteria: AcceptanceCriterion[];
  contract: ClauseContract;
}

interface LLMDecompositionOutput {
  customer_experience: string;
  preconditions: string[];
  clauses: LLMClauseOutput[];
}

async function callDecompositionLLM(userMessage: string): Promise<{
  parsed: LLMDecompositionOutput;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  const proxyUrl = Deno.env.get("STATION_PROXY_URL");
  const apiKey = Deno.env.get("NOUS_API_KEY");
  if (!proxyUrl || !apiKey) {
    throw new Error("STATION_PROXY_URL or NOUS_API_KEY not set — cannot call LLM");
  }

  const requestBody = {
    model: "opus",
    max_tokens: 8192,
    system: DECOMPOSITION_SYSTEM_PROMPT,
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

  let apiResponse: AnthropicResponseLike & {
    content?: Array<{ type: string; text: string }>;
  };
  try {
    apiResponse = JSON.parse(raw);
  } catch (err) {
    throw new Error(`station-proxy returned non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`);
  }

  const textBlock = apiResponse.content?.find((c) => c.type === "text");
  const outputText = textBlock?.text ?? "";
  const cleaned = stripJsonFences(outputText);

  let parsed: LLMDecompositionOutput;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Decomposition LLM JSON parse failed: ${(err as Error).message}: ${cleaned.slice(0, 300)}`);
  }

  // Validate structure
  if (!parsed.customer_experience || !Array.isArray(parsed.clauses)) {
    throw new Error(`Decomposition LLM output missing required fields: ${Object.keys(parsed).join(", ")}`);
  }
  if (parsed.clauses.length === 0) {
    throw new Error("Decomposition LLM returned zero clauses");
  }
  if (parsed.clauses.length > 12) {
    throw new Error(`Decomposition LLM returned ${parsed.clauses.length} clauses (max 12)`);
  }

  const tokens = tokensFromResponse(apiResponse);
  const cost_usd = costFromTokens("claude-opus-4-6", tokens.tokens_in, tokens.tokens_out);

  return {
    parsed,
    tokens_in: tokens.tokens_in,
    tokens_out: tokens.tokens_out,
    cost_usd,
  };
}

function buildUserMessage(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  grillDecisions: GrillDecisionRow[],
  architectureDoc: string | null,
  projectTag: string,
  prefix: string,
): string {
  const parts: string[] = [];

  parts.push(`## Feature\n- ID: ${featureId}\n- Name: ${featureName ?? "(unnamed)"}\n- Project: ${projectTag}\n- Prefix: ${prefix}\n- Description: ${description ?? "(no description)"}`);

  if (grillDecisions.length > 0) {
    parts.push(`\n## Grill Decisions (${grillDecisions.length} resolved)`);
    for (const gd of grillDecisions) {
      const sev = gd.severity ? ` [${gd.severity}]` : "";
      const cat = gd.category ? ` (${gd.category})` : "";
      parts.push(`- ${gd.decision}${sev}${cat}\n  Rationale: ${gd.rationale}`);
    }
  }

  if (architectureDoc) {
    parts.push(`\n## Architecture Document\n${architectureDoc}`);
  }

  parts.push(`\n## Contract Example\n${CONTRACT_EXAMPLE}`);

  parts.push(`\n## Instructions\nDecompose this feature into bible clauses using Working Backwards. Start from the customer experience, derive preconditions, then derive clauses. Use placeholder IDs (C1, C2, ...) for cross-references in requires/enables — they will be replaced with real IDs (${prefix}.XX.1, ${prefix}.XX.2, ...).`);

  return parts.join("\n");
}

async function supersedeOldClauses(featureId: string, newClauseIds: string[]): Promise<string[]> {
  const sb = getSupabaseClient();
  // Find existing clauses for this feature that aren't in the new set
  // deno-lint-ignore no-explicit-any
  const { data: existing } = await (sb as any)
    .from("bible_clauses")
    .select("id")
    .eq("feature_id", featureId)
    .not("id", "in", `(${newClauseIds.join(",")})`)
    .in("status", ["draft", "active"]);

  const superseded: string[] = [];
  if (existing && existing.length > 0) {
    const oldIds = existing.map((r: { id: string }) => r.id);
    // deno-lint-ignore no-explicit-any
    await (sb as any)
      .from("bible_clauses")
      .update({
        status: "deprecated",
        deprecation: {
          reason: "superseded_by_scoper_regeneration",
          superseded_by: newClauseIds,
          deprecated_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .in("id", oldIds);
    superseded.push(...oldIds);
  }
  return superseded;
}

async function insertGeneratedClauses(
  clauses: LLMClauseOutput[],
  prefix: string,
  featureId: string,
  startSequence: number,
  sessionId: string,
): Promise<ClauseSpec[]> {
  const sb = getSupabaseClient();

  // Extract feature number from featureId
  const featureMatch = featureId.match(/\.(\d+)$/);
  const featureNum = featureMatch ? featureMatch[1] : featureId.replace(/\./g, "_");

  // Build placeholder → real ID mapping
  const idMap = new Map<string, string>();
  for (let i = 0; i < clauses.length; i++) {
    const realId = `${prefix}.${featureNum}.${startSequence + i}`;
    idMap.set(clauses[i].placeholder_id, realId);
  }

  const specs: ClauseSpec[] = [];
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < clauses.length; i++) {
    const c = clauses[i];
    const realId = idMap.get(c.placeholder_id)!;
    const bodyHash = await sha256HexAsync(c.body);

    // Resolve placeholder refs in requires/enables
    const requires = c.requires
      .map((r) => idMap.get(r) ?? r)
      .filter((r) => r !== realId); // no self-ref
    const enables = c.enables
      .map((e) => idMap.get(e) ?? e)
      .filter((e) => e !== realId);

    const spec: ClauseSpec = {
      id: realId,
      prefix,
      parent_id: [featureId],
      title: c.title,
      feature_id: featureId,
      sequence_order: startSequence + i,
      maturity_stage: "SPEC",
      status: "draft",
      clause_type: c.clause_type,
      critical_path: c.critical_path,
      requires,
      enables,
      acceptance_criteria: c.acceptance_criteria,
      body: c.body,
      contract: c.contract,
    };
    specs.push(spec);

    rows.push({
      id: realId,
      prefix,
      revision: "r1",
      parent_id: [featureId],
      hash: bodyHash,
      status: "draft",
      birth_session: sessionId,
      birth_author: "scoper-v3",
      birth_context: `LLM Working Backwards decomposition for feature ${featureId}`,
      body: c.body,
      file_path: `bible/${prefix}/${realId}.md`,
      acceptance_criteria: c.acceptance_criteria,
      requires,
      enables,
      critical_path: c.critical_path,
      clause_type: c.clause_type,
      feature_id: featureId,
      sequence_order: startSequence + i,
      maturity_stage: "SPEC",
      contract: c.contract,
      frontmatter: {
        title: c.title,
        generated_by: "scoper-v3",
        generated_at: new Date().toISOString(),
      },
    });
  }

  // Batch insert
  // deno-lint-ignore no-explicit-any
  const { error } = await (sb as any)
    .from("bible_clauses")
    .insert(rows);
  if (error) {
    throw new Error(`decomposition.insertGeneratedClauses: ${error.message}`);
  }

  // Update features.clauses array
  const newClauseIds = specs.map((s) => s.id);
  // deno-lint-ignore no-explicit-any
  const { error: fErr } = await (sb as any)
    .from("features")
    .update({
      clauses: newClauseIds,
      updated_at: new Date().toISOString(),
    })
    .eq("id", featureId);
  if (fErr) {
    throw new Error(`decomposition.updateFeatureClauses: ${fErr.message}`);
  }

  return specs;
}

async function generateClauses(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  architectureDoc: string | null,
  projectTag: string,
  sessionId: string,
): Promise<DecompositionOutput> {
  // 1. Load grill decisions
  const grillDecisions = await loadGrillDecisions(featureId, projectTag);

  // 2. Resolve prefix
  const prefix = await resolvePrefix(projectTag);

  // 3. Build LLM prompt
  const userMessage = buildUserMessage(
    featureId, featureName, description,
    grillDecisions, architectureDoc, projectTag, prefix,
  );

  // 4. Call LLM
  const { parsed, tokens_in, tokens_out, cost_usd } = await callDecompositionLLM(userMessage);

  // 5. Assign real IDs + insert
  const startSeq = await getNextSequence(prefix, featureId);

  // 6. Supersede old clauses if re-running (idempotency decision Q3c)
  const placeholderIds = parsed.clauses.map(c => c.placeholder_id);
  // We need to build the real ID list first to exclude from supersession
  const featureMatch = featureId.match(/\.(\d+)$/);
  const featureNum = featureMatch ? featureMatch[1] : featureId.replace(/\./g, "_");
  const newIds = parsed.clauses.map((_, i) => `${prefix}.${featureNum}.${startSeq + i}`);
  const superseded = await supersedeOldClauses(featureId, newIds);

  // 7. Insert new clauses
  const specs = await insertGeneratedClauses(
    parsed.clauses, prefix, featureId, startSeq, sessionId,
  );

  // 8. Build preconditions from generated clauses
  const preconditions = specs
    .filter(s => s.requires.length === 0)
    .map(s => `${s.id} — ${s.title}`);

  return {
    customer_experience: parsed.customer_experience,
    preconditions: preconditions.length > 0 ? preconditions : parsed.preconditions,
    clauses: specs,
    generated: true,
    tokens_in,
    tokens_out,
    cost_usd,
  };
}

// ─── Top-level: route between generate and enrich ───────────────────────────

export async function decomposeFeature(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseIds: string[],
  opts?: {
    architectureDoc?: string | null;
    projectTag?: string;
    sessionId?: string;
  },
): Promise<DecompositionOutput> {
  // Generate mode: no existing clauses → LLM creates them
  if (clauseIds.length === 0 && opts?.projectTag && opts?.sessionId) {
    return await generateClauses(
      featureId, featureName, description,
      opts.architectureDoc ?? null,
      opts.projectTag,
      opts.sessionId,
    );
  }

  // Enrich mode: existing clauses → read + enrich ACs (original behavior)
  return await enrichExistingClauses(featureId, featureName, description, clauseIds);
}
