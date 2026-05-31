// supabase/functions/scoper/decomposition.ts
// AGT.1.2 + AGT.1.2.A1 — Working Backwards decomposition + Ulwick AC derivation.
//
// TWO MODES:
//   Generate mode: features.clauses is empty → LLM generates clauses from
//     grill decisions + architecture doc + feature description via opus.
//   Enrich mode: features.clauses has pre-existing IDs → read existing
//     clauses, ENRICH with LLM (ACs, contracts, antipatterns, verification).
//
// AGT.1.2.A1 fix: enrich mode now calls opus to derive proper ACs, contracts,
// and antipatterns instead of producing template ACs mechanically. Mechanical
// deriveACs() is fallback only when LLM is unreachable.

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

// ─── LLM system prompt (generate mode — creates clauses from scratch) ───────


// ─── LLM enrichment prompt (enrich mode — enriches existing clauses) ────────
// AGT.1.2.A1: This prompt is used when clauses already exist but need proper
// ACs, contracts, antipatterns, and verification commands.

const ENRICHMENT_SYSTEM_PROMPT = `You are Scoper, the autonomous planning engine for the NOUS factory pipeline.
You are in ENRICH MODE: clauses already exist with bodies written by a human planner.
Your job is to enrich each clause with production-grade acceptance criteria, contracts,
and antipatterns — NOT to rewrite the clause bodies.

For each clause, you must produce:

1. customer_experience: A Working Backwards statement (1 paragraph). Start from what the
   end user sees when ALL these clauses ship together. Not a template — a real description
   of the customer outcome.

2. Per clause, acceptance_criteria (2-8 per clause):
   Each AC must be independently verifiable. Format:
   { "id": "AC01", "text": "...", "verification": "auto|physical_qa|kosta_review", "form": "ulwick|technical_spec" }

   RULES for ACs:
   - "auto" verification MUST include a concrete command in the text or contract.verification
     (curl endpoint, SQL query, grep pattern, file existence check)
   - "physical_qa" for anything requiring human eyes (UI rendering, visual layout, UX flow)
   - "kosta_review" for brand, tone, strategic decisions
   - "ulwick" form for user-facing: "When [context], the [user/system] can [action] so that [outcome]"
   - "technical_spec" form for plumbing: "[Component] [action] with [specific behavior]"
   - BANNED: generic ACs like "works correctly", "no regressions", "ships when pushed to staging"
   - BANNED: ACs that just restate the clause body
   - Each AC must test ONE specific behavior, not a bundle

3. Per clause, contract object:
   {
     "elements": [{"id": "E01", "kind": "endpoint|component|table|migration|edge_fn|cron|interaction|side_effect", "name": "descriptive name"}],
     "exclusions": [{"kind": "...", "name": "what's NOT in scope", "prior": "why excluded — reference grill decision if applicable"}],
     "antipatterns": [{"id": "AP01", "text": "Do NOT ... — because [reason from grill decision or architectural constraint]"}],
     "verification": [{"target": "E01|AC01", "method": "curl|sql|grep|visual|code_check|e2e", "command": "actual command to run", "expect": "expected output or behavior"}]
   }

   RULES for contracts:
   - Elements: every file, table, endpoint, component the clause creates or modifies
   - Exclusions: things explicitly NOT in scope (from grill decisions, deferred items)
   - Antipatterns: invert each relevant grill decision into a "Do NOT" statement.
     Also add common failure modes for the clause type (e.g., for migrations: "Do NOT run
     destructive DDL without IF EXISTS guards")
   - Verification: CONCRETE commands. Not "check the endpoint" but "curl -s http://localhost:8000/v1/foo | jq .status"
     Not "verify table exists" but "SELECT column_name FROM information_schema.columns WHERE table_name='foo'"

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
- Read the clause body carefully — ACs must verify what the body specifies, not generic outcomes
- If a clause body mentions specific tables, endpoints, or files — those go in contract.elements
- Minimum 2 ACs per clause, maximum 8
- Every element must have a verification entry
- Every exclusion should reference why it's excluded (grill decision ID if available)`;

// ─── Few-shot contract example (injected into user message) ─────────────────


// ─── Helpers ────────────────────────────────────────────────────────────────

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

async function sha256HexAsync(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Mechanical AC derivation (FALLBACK ONLY — AGT.1.2.A1) ─────────────────

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

// ─── Customer experience drafting (mechanical fallback) ─────────────────────

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

// ─── LLM enrichment for existing clauses (AGT.1.2.A1) ──────────────────────

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
    // Truncate to avoid exceeding context — architecture docs can be long
    const maxArchLen = 8000;
    const archText = architectureDoc.length > maxArchLen
      ? architectureDoc.slice(0, maxArchLen) + "\n... (truncated)"
      : architectureDoc;
    parts.push(`\n## Architecture Document\n${archText}`);
  }

  parts.push(`\n## Existing Clauses to Enrich (${clauses.length})`);
  for (const c of clauses) {
    const title = clauseTitleFromFrontmatter(c.frontmatter) || c.id;
    const bodyPreview = (c.body ?? "").slice(0, 2000);
    const clauseType = c.clause_type ?? "feature";
    parts.push(`\n### ${c.id} — ${title} (type: ${clauseType}, critical_path: ${c.critical_path ?? false})`);
    parts.push(bodyPreview);
  }


  parts.push(`\n## Instructions\nEnrich each clause above with:
1. 2-8 acceptance criteria (Ulwick form for user-facing, technical_spec for plumbing)
2. Full contract (elements from what the body describes, exclusions from grill deferred items, antipatterns from grill decision inversions, verification with real commands)
3. A Working Backwards customer_experience statement for the whole feature

Use the EXACT clause IDs shown above. Do NOT rename them.`);

  return parts.join("\n");
}


async function callEnrichmentLLM(userMessage: string): Promise<{
  parsed: EnrichmentLLMOutput;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}> {
  const proxyUrl = Deno.env.get("STATION_PROXY_URL") ?? "http://54.174.233.250:8095";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 130_000);

  let response: Response;
  try {
    response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonnet",
        max_tokens: 8192,
        system: ENRICHMENT_SYSTEM_PROMPT,
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

  let apiResponse: { content?: Array<{ type: string; text: string }>; usage?: { input_tokens: number; output_tokens: number } };
  try {
    apiResponse = JSON.parse(raw);
  } catch (err) {
    throw new Error(`station-proxy returned non-JSON: ${(err as Error).message}: ${raw.slice(0, 200)}`);
  }

  const textBlock = apiResponse.content?.find((c) => c.type === "text");
  const outputText = textBlock?.text ?? "";
  const cleaned = stripJsonFences(outputText);

  const tokens_in = apiResponse.usage?.input_tokens ?? 0;
  const tokens_out = apiResponse.usage?.output_tokens ?? 0;
  const cost_usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000;

  let parsed: EnrichmentLLMOutput;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Enrichment LLM JSON parse failed: ${(err as Error).message}: ${cleaned.slice(0, 300)}`);
  }

  return { parsed, tokens_in, tokens_out, cost_usd };
}



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
  // Load grill decisions for context
  const grillDecisions = await loadGrillDecisions(featureId, projectTag);

  // Build enrichment prompt — batch all clauses (max 12 per AGT.1.2.A1 AP04)
  // If >12 clauses, chunk them
  const MAX_BATCH = 12;
  let allTokensIn = 0;
  let allTokensOut = 0;
  let allCost = 0;
  let customerExperience = "";
  const enrichments = new Map<string, { acceptance_criteria: AcceptanceCriterion[]; contract: ClauseContract }>();

  for (let offset = 0; offset < clauseRows.length; offset += MAX_BATCH) {
    const batch = clauseRows.slice(offset, offset + MAX_BATCH);
    const userMessage = buildEnrichmentMessage(
      featureId, featureName, description,
      batch, grillDecisions, architectureDoc, projectTag,
    );

    const { parsed, tokens_in, tokens_out, cost_usd } = await callEnrichmentLLM(userMessage);
    allTokensIn += tokens_in;
    allTokensOut += tokens_out;
    allCost += cost_usd;

    // Use customer_experience from first batch
    if (offset === 0) {
      customerExperience = parsed.customer_experience;
    }

    // Map enrichments by clause ID
    for (const ec of parsed.enriched_clauses) {
      if (ec.id && Array.isArray(ec.acceptance_criteria) && ec.contract) {
        // Validate ACs have proper structure
        const validACs = ec.acceptance_criteria
          .filter((ac) => ac.text && ac.verification && ac.form)
          .map((ac, i) => ({
            id: ac.id || `AC${String(i + 1).padStart(2, "0")}`,
            text: ac.text,
            verification: (["auto", "physical_qa", "kosta_review"].includes(ac.verification)
              ? ac.verification
              : "auto") as "auto" | "physical_qa" | "kosta_review",
            form: (ac.form === "ulwick" || ac.form === "technical_spec"
              ? ac.form
              : "technical_spec") as "ulwick" | "technical_spec",
          }));

        // Ensure contract has all required arrays
        const contract: ClauseContract = {
          elements: Array.isArray(ec.contract.elements) ? ec.contract.elements : [],
          exclusions: Array.isArray(ec.contract.exclusions) ? ec.contract.exclusions : [],
          antipatterns: Array.isArray(ec.contract.antipatterns) ? ec.contract.antipatterns : [],
          verification: Array.isArray(ec.contract.verification) ? ec.contract.verification : [],
        };

        if (validACs.length >= 2) {
          enrichments.set(ec.id, { acceptance_criteria: validACs, contract });
        }
      }
    }
  }

  return {
    customer_experience: customerExperience,
    enrichments,
    tokens_in: allTokensIn,
    tokens_out: allTokensOut,
    cost_usd: allCost,
  };
}

// ─── Enrich mode: read existing clauses + LLM enrichment ────────────────────

async function enrichExistingClauses(
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
  if (clauseIds.length === 0) {
    const customer_experience = draftCustomerExperience(featureName, description);
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

  // ─── AGT.1.2.A1: Try LLM enrichment first, mechanical fallback ───────────
  let llmCustomerExperience: string | null = null;
  let llmEnrichments: Map<string, { acceptance_criteria: AcceptanceCriterion[]; contract: ClauseContract }> | null = null;
  let enrichTokensIn = 0;
  let enrichTokensOut = 0;
  let enrichCost = 0;
  let enriched = false;

  if (opts?.projectTag) {
    try {
      const result = await enrichWithLLM(
        featureId, featureName, description,
        rows,
        opts.architectureDoc ?? null,
        opts.projectTag,
      );
      llmCustomerExperience = result.customer_experience;
      llmEnrichments = result.enrichments;
      enrichTokensIn = result.tokens_in;
      enrichTokensOut = result.tokens_out;
      enrichCost = result.cost_usd;
      enriched = true;
    } catch (err) {
      // AGT.1.2.A1 AP05: Log LLM failure, don't swallow silently
      console.error(`[scoper] enrichment LLM failed, falling back to mechanical: ${(err as Error).message}`);
      // The step logging with "enrichment_llm_fallback" is done by plan.ts
      // which reads the `generated` flag and tokens to detect fallback
    }
  }

  const customer_experience = llmCustomerExperience ?? draftCustomerExperience(featureName, description);

  const clauses: ClauseSpec[] = rows.map((r) => {
    // Check if LLM produced enrichment for this clause
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
      // Use LLM-enriched ACs if available, otherwise mechanical fallback
      acceptance_criteria: enrichment?.acceptance_criteria ?? deriveACsMechanical(r),
      body: r.body ?? "",
      // Use LLM-enriched contract if available, preserve existing if present
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
    // Track LLM usage even in enrich mode (AGT.1.2.A1 AC07)
    tokens_in: enriched ? enrichTokensIn : undefined,
    tokens_out: enriched ? enrichTokensOut : undefined,
    cost_usd: enriched ? enrichCost : undefined,
  };
}

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
  // Scoper no longer generates clauses — clause bodies are authored by Cowork
  // during grilling sessions. If no clauses exist, return empty (plan.ts emits Mode C).
  // Enrich mode: read existing clauses + derive ACs (LLM enrichment with mechanical fallback)
  return await enrichExistingClauses(featureId, featureName, description, clauseIds, opts);
}

