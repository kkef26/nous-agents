// supabase/functions/scoper/decomposition.ts
// AGT.1.2 — Working Backwards decomposition + Ulwick AC derivation.
//
// Step 2 (plan playbook):
//   1. Draft customer_experience statement from features.name / .description.
//   2. List preconditions (derived from the feature's body + existing clauses' bodies).
//   3. List clauses per precondition (from bible_clauses already linked via features.clauses).
//
// Step 3 (AC derivation):
//   Ulwick outcome statements for user-facing work + technical-spec form for
//   plumbing. Each AC carries a verification field (auto | physical_qa |
//   kosta_review) per the grilling-decision constraint:
//   "Generic ACs banned. Every AC carries verification."

import { getSupabaseClient } from "../_common/db.ts";

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

export interface DecompositionOutput {
  customer_experience: string;
  preconditions: string[];
  clauses: ClauseSpec[];
}

// ─── Customer experience drafting ────────────────────────────────────────────

function draftCustomerExperience(featureName: string | undefined, description: string | undefined): string {
  const name = (featureName ?? "this feature").trim();
  const desc = (description ?? "").trim();
  if (desc.length > 0) {
    return `When ${name} is shipped, the customer experiences: ${desc}`;
  }
  return `When ${name} is shipped, the customer experiences the outcome stated in the feature spec.`;
}

// ─── Preconditions ───────────────────────────────────────────────────────────

function derivePreconditions(clauseRows: BibleClauseRow[]): string[] {
  // Working-Backwards preconditions are the inverse-DAG roots: clauses with
  // no `requires` are the foundational preconditions; ones that 'enable'
  // downstream work imply their existence is a precondition for that work.
  const ids = new Set(clauseRows.map((c) => c.id));
  const roots = clauseRows.filter((c) => {
    const reqs = (c.requires ?? []).filter((r) => ids.has(r));
    return reqs.length === 0;
  });
  if (roots.length === 0) return ["(no foundational clauses identified — review feature scoping)"];
  return roots.map((r) => `${r.id} — ${r.title ?? "(no title)"}`);
}

// ─── AC derivation ───────────────────────────────────────────────────────────

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
  // Existing rows may carry array of strings, array of objects, or null.
  const list: Array<string | Record<string, unknown>> = Array.isArray(raw)
    ? (raw as Array<string | Record<string, unknown>>)
    : [];

  if (list.length === 0) {
    // Synthesize a minimum-viable spec-form AC so Conductor verify has
    // something cold-readable. Real AC authoring happens in grilling; this
    // is the safety net for SCAFFOLD-stage clauses.
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
      return {
        id,
        text: item,
        verification: inferVerification(item, clause.clause_type ?? ""),
        form,
      };
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

// ─── Top-level: load clauses + build output ──────────────────────────────────

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
}

function clauseTitleFromFrontmatter(fm: Record<string, unknown> | null): string {
  if (!fm) return "";
  const t = fm.title;
  return typeof t === "string" ? t : "";
}

export async function decomposeFeature(
  featureId: string,
  featureName: string | undefined,
  description: string | undefined,
  clauseIds: string[],
): Promise<DecompositionOutput> {
  const customer_experience = draftCustomerExperience(featureName, description);

  if (clauseIds.length === 0) {
    return { customer_experience, preconditions: [], clauses: [] };
  }

  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("bible_clauses")
    .select(
      "id, prefix, parent_id, feature_id, sequence_order, maturity_stage, status, clause_type, critical_path, requires, enables, acceptance_criteria, body, frontmatter",
    )
    .in("id", clauseIds);
  if (error) {
    throw new Error(`decomposition.decomposeFeature: ${error.message}`);
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
  }));

  // Sort by sequence_order then id for deterministic output
  clauses.sort((a, b) => {
    if (a.sequence_order !== b.sequence_order) return a.sequence_order - b.sequence_order;
    return a.id.localeCompare(b.id);
  });

  return { customer_experience, preconditions, clauses };
}
