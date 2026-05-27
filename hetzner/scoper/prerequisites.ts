// supabase/functions/scoper/prerequisites.ts
// AGT.1.2 — 7-point prerequisite check.
//
// Points #1-#4 + #7 are mechanically fixable inline by Scoper when the gap is
// a simple lookup/derivation. Points #5 (ARCHITECTURE.md) and #6 (grill)
// are MANDATORY GATES — missing either = automatic Mode B, no exception
// (per Scoper v3 persona spec and ARCHITECTURE.md "Scoper cannot bypass the
// grill gate or architecture gate (both MANDATORY)").
//
// GAP 3 fix (2026-05-26): Point #2 staging branch probe now uses git refs API
// instead of README.md existence check. Prior approach was fragile — repos
// without README.md failed even if staging branch existed.

import { getSupabaseClient } from "../common/db.ts";
import { getFileContent, getRef } from "../common/github.ts";

const GITHUB_OWNER = "kkef26";

export type CheckResult = "pass" | "fail" | "fixed_inline";

export interface CheckOutcome {
  point: number;
  name: string;
  result: CheckResult;
  gate: "soft" | "mandatory";
  detail: string;
  fixed_value?: unknown;
}

export interface PrerequisiteSummary {
  outcomes: CheckOutcome[];
  all_pass: boolean;
  mandatory_gates_pass: boolean;     // gates #5 + #6 only
  blocking_failures: CheckOutcome[]; // any check whose result==='fail'
}

export interface FeatureRow {
  id: string;
  project: string;
  name?: string;
  description?: string;
  clauses?: string[] | null;
  grill_completed_at?: string | null;
  grill_decision_count?: number | null;
  architecture_completed_at?: string | null;
  architecture_doc_path?: string | null;
  architecture_doc?: string | null;
}

export interface ProjectRow {
  tag: string;
  canonical_repo: string | null;
  canonical_vercel_project: string | null;
  deploy_target: string | null;
  supabase_ref: string | null;
}

// ─── Individual checks ───────────────────────────────────────────────────────

async function checkCanonicalRepo(p: ProjectRow): Promise<CheckOutcome> {
  if (p.canonical_repo && p.canonical_repo.length > 0) {
    return {
      point: 1, name: "canonical_repo", result: "pass", gate: "soft",
      detail: `nous.projects.canonical_repo='${p.canonical_repo}'`,
    };
  }
  return {
    point: 1, name: "canonical_repo", result: "fail", gate: "soft",
    detail: "nous.projects.canonical_repo is null — Conductor cannot merge without it (L22-REPO-REGISTER).",
  };
}

async function checkStagingBranch(p: ProjectRow): Promise<CheckOutcome> {
  if (!p.canonical_repo) {
    return {
      point: 2, name: "staging_branch", result: "fail", gate: "soft",
      detail: "cannot verify staging branch without canonical_repo",
    };
  }
  try {
    // GAP 3 fix: use git refs API instead of README.md existence check.
    // GET /repos/{owner}/{repo}/git/refs/heads/staging returns the ref object
    // if the branch exists, 404 if it doesn't.
    const repo = p.canonical_repo.split("/")[1] ?? p.canonical_repo;
    const ref = await getRef(GITHUB_OWNER, repo, "heads/staging");
    return {
      point: 2, name: "staging_branch", result: "pass", gate: "soft",
      detail: `staging branch exists (sha=${typeof ref === "object" && ref ? (ref as Record<string, unknown>).sha ?? (ref as Record<string, unknown>).object?.toString() : "verified"})`,
    };
  } catch (err) {
    return {
      point: 2, name: "staging_branch", result: "fail", gate: "soft",
      detail: `staging branch not accessible: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkDeployConfig(p: ProjectRow): Promise<CheckOutcome> {
  const target = p.deploy_target ?? null;
  if (target && target.length > 0) {
    return {
      point: 3, name: "deploy_config", result: "pass", gate: "soft",
      detail: `deploy_target='${target}'`,
    };
  }
  return {
    point: 3, name: "deploy_config", result: "fail", gate: "soft",
    detail: "nous.projects.deploy_target is null",
  };
}

async function checkCredentials(p: ProjectRow): Promise<CheckOutcome> {
  const sb = getSupabaseClient();
  const { data } = await sb
    .from("config")
    .select("key")
    .in("key", ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);
  const have = new Set(((data ?? []) as Array<{ key: string }>).map((r) => r.key));
  const missing: string[] = [];
  if (!have.has("GITHUB_TOKEN")) missing.push("GITHUB_TOKEN");
  if (missing.length === 0) {
    return {
      point: 4, name: "credentials", result: "pass", gate: "soft",
      detail: "nous.config has GITHUB_TOKEN",
    };
  }
  return {
    point: 4, name: "credentials", result: "fail", gate: "soft",
    detail: `nous.config missing: ${missing.join(", ")}`,
  };
}

/**
 * Point #5 — ARCHITECTURE GATE (MANDATORY).
 *
 * Either the feature row carries architecture_completed_at + architecture_doc
 * (or architecture_doc_path), OR an ARCHITECTURE.md exists at the repo root.
 * If neither: hard fail, no inline fix.
 */
async function checkArchitectureGate(
  f: FeatureRow,
  p: ProjectRow,
): Promise<CheckOutcome> {
  if (f.architecture_completed_at && (f.architecture_doc || f.architecture_doc_path)) {
    return {
      point: 5, name: "architecture_gate", result: "pass", gate: "mandatory",
      detail: `feature has architecture (completed_at=${f.architecture_completed_at})`,
    };
  }
  // Fallback: check ARCHITECTURE.md at repo root
  if (p.canonical_repo) {
    try {
      const repo = p.canonical_repo.split("/")[1] ?? p.canonical_repo;
      const { content } = await getFileContent(GITHUB_OWNER, repo, "ARCHITECTURE.md", "staging");
      if (content.length > 200) {
        return {
          point: 5, name: "architecture_gate", result: "pass", gate: "mandatory",
          detail: `ARCHITECTURE.md present at repo root (${content.length} bytes)`,
        };
      }
      return {
        point: 5, name: "architecture_gate", result: "fail", gate: "mandatory",
        detail: `ARCHITECTURE.md present but suspiciously small (${content.length} bytes)`,
      };
    } catch (_err) {
      return {
        point: 5, name: "architecture_gate", result: "fail", gate: "mandatory",
        detail: "ARCHITECTURE.md missing at repo root AND features.architecture_completed_at is null",
      };
    }
  }
  return {
    point: 5, name: "architecture_gate", result: "fail", gate: "mandatory",
    detail: "no canonical_repo and no feature.architecture_doc — cannot resolve architecture gate",
  };
}

/**
 * Point #6 — GRILL GATE (MANDATORY).
 *
 * features.grill_completed_at must be non-null. grill_decision_count ≥ 4
 * (depth threshold per grill resolution spec). No inline fix path.
 */
function checkGrillGate(f: FeatureRow): CheckOutcome {
  if (!f.grill_completed_at) {
    return {
      point: 6, name: "grill_gate", result: "fail", gate: "mandatory",
      detail: "features.grill_completed_at is null — grilling session not run",
    };
  }
  const depth = f.grill_decision_count ?? 0;
  if (depth < 4) {
    return {
      point: 6, name: "grill_gate", result: "fail", gate: "mandatory",
      detail: `grill depth ${depth} < required 4 (per grill_resolution spec)`,
    };
  }
  return {
    point: 6, name: "grill_gate", result: "pass", gate: "mandatory",
    detail: `grill_completed_at=${f.grill_completed_at}, depth=${depth}`,
  };
}

async function checkNoOverlap(f: FeatureRow): Promise<CheckOutcome> {
  // #7: feature's clauses should not overlap with active work on other features
  // in the same project. Simple check: any clause already at maturity SHIPPED
  // / RATIFIED owned by a different feature_id?
  const clauseIds = (f.clauses ?? []).filter((c) => typeof c === "string");
  if (clauseIds.length === 0) {
    return {
      point: 7, name: "no_overlap", result: "pass", gate: "soft",
      detail: "feature has no clauses yet — nothing to overlap",
    };
  }
  const sb = getSupabaseClient();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (sb as any)
    .from("bible_clauses")
    .select("id, feature_id, status")
    .in("id", clauseIds);
  if (error) {
    return {
      point: 7, name: "no_overlap", result: "fail", gate: "soft",
      detail: `overlap check db error: ${error.message}`,
    };
  }
  const rows = (data ?? []) as Array<{ id: string; feature_id: string | null; status: string | null }>;
  const stolen = rows.filter((r) => r.feature_id && r.feature_id !== f.id);
  if (stolen.length > 0) {
    return {
      point: 7, name: "no_overlap", result: "fail", gate: "soft",
      detail: `clauses bound to a different feature: ${stolen.map((s) => `${s.id}→${s.feature_id}`).join(", ")}`,
    };
  }
  return {
    point: 7, name: "no_overlap", result: "pass", gate: "soft",
    detail: `${rows.length} clause(s) verified, no overlap`,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runPrerequisiteChecks(
  feature: FeatureRow,
  project: ProjectRow,
): Promise<PrerequisiteSummary> {
  // Soft checks run in parallel; mandatory gates are sequential and short.
  const [c1, c2, c3, c4, c5, c7] = await Promise.all([
    checkCanonicalRepo(project),
    checkStagingBranch(project),
    checkDeployConfig(project),
    checkCredentials(project),
    checkArchitectureGate(feature, project),
    checkNoOverlap(feature),
  ]);
  const c6 = checkGrillGate(feature);

  const outcomes: CheckOutcome[] = [c1, c2, c3, c4, c5, c6, c7];
  const blocking_failures = outcomes.filter((o) => o.result === "fail");
  const mandatory_gates_pass =
    c5.result !== "fail" && c6.result !== "fail";
  const all_pass = blocking_failures.length === 0;

  return { outcomes, all_pass, mandatory_gates_pass, blocking_failures };
}
