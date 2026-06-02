// hetzner/scoper/src/prerequisites.ts
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
//
// PIPE.CLEANUP D3+D6 (2026-05-29): Points #5 and #6 now query source tables
// (grill_decisions, library_artifacts) directly instead of features row
// derived fields. Root cause: Cowork never stamped features.grill_completed_at
// or features.architecture_completed_at, making most features appear ungrilled.
// The auto-stamp trigger (trg_stamp_feature_grill) covers future writes, but
// the prereq gates must not depend on derived fields alone.

import { getSupabaseClient } from "./lib/common/db.js";
import { getFileContent, getRef } from "./lib/common/github.js";
import { countGrillDecisions, hasArchitectureDoc } from "./lib/common/source_material.js";

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
      detail: `staging branch exists (sha=${typeof ref === "object" && ref ? (ref as unknown as Record<string, unknown>).sha ?? (ref as unknown as Record<string, unknown>).object?.toString() : "verified"})`,
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

async function checkCredentials(_p: ProjectRow): Promise<CheckOutcome> {
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
 * PIPE.CLEANUP D3+D6: queries library_artifacts for architecture-tagged docs
 * for this project first (source of truth). Falls back to features row fields,
 * then to ARCHITECTURE.md at repo root. Removes single-point dependency on
 * features.architecture_completed_at which was inconsistently written.
 */
async function checkArchitectureGate(
  f: FeatureRow,
  p: ProjectRow,
): Promise<CheckOutcome> {
  // Primary path: query library_artifacts for architecture docs (D3 Option C)
  try {
    const hasDoc = await hasArchitectureDoc(f.project ?? p.tag);
    if (hasDoc) {
      return {
        point: 5, name: "architecture_gate", result: "pass", gate: "mandatory",
        detail: `architecture doc found in library_artifacts for project=${f.project ?? p.tag}`,
      };
    }
  } catch (err) {
    // Log but don't fail — fall through to secondary paths
    console.warn(`[prereq] architecture doc query failed, falling back: ${(err as Error).message}`);
  }

  // Secondary path: features row (for backward compat with older features)
  if (f.architecture_completed_at && (f.architecture_doc || f.architecture_doc_path)) {
    return {
      point: 5, name: "architecture_gate", result: "pass", gate: "mandatory",
      detail: `feature has architecture (completed_at=${f.architecture_completed_at})`,
    };
  }

  // Tertiary fallback: check ARCHITECTURE.md at repo root
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
        detail: "no architecture doc in library_artifacts, features row, or repo root ARCHITECTURE.md",
      };
    }
  }
  return {
    point: 5, name: "architecture_gate", result: "fail", gate: "mandatory",
    detail: "no canonical_repo and no architecture doc in library_artifacts or feature row",
  };
}

/**
 * Point #6 — GRILL GATE (MANDATORY).
 *
 * PIPE.CLEANUP D3: queries grill_decisions table directly instead of relying
 * on features.grill_completed_at (which was never written by Cowork sessions).
 * Counts feature-specific decisions (feature_id = X) + project-wide decisions
 * (feature_id IS NULL AND project = Y). Threshold: >= 4 per grill resolution spec.
 *
 * Falls back to features row fields for backward compat.
 */
async function checkGrillGate(f: FeatureRow, p: ProjectRow): Promise<CheckOutcome> {
  // Primary path: query grill_decisions directly (D3 Option C)
  try {
    const { count, featureSpecific, projectWide } = await countGrillDecisions(
      f.id,
      f.project ?? p.tag,
    );

    if (count >= 4) {
      return {
        point: 6, name: "grill_gate", result: "pass", gate: "mandatory",
        detail: `grill depth=${count} (${featureSpecific} feature-specific + ${projectWide} project-wide) >= required 4`,
      };
    }

    if (count > 0) {
      return {
        point: 6, name: "grill_gate", result: "fail", gate: "mandatory",
        detail: `grill depth ${count} (${featureSpecific} feature + ${projectWide} project) < required 4`,
      };
    }
  } catch (err) {
    // Log but don't fail — fall through to features row
    console.warn(`[prereq] grill_decisions query failed, falling back: ${(err as Error).message}`);
  }

  // Secondary fallback: features row (for backward compat)
  if (f.grill_completed_at) {
    const depth = f.grill_decision_count ?? 0;
    if (depth >= 4) {
      return {
        point: 6, name: "grill_gate", result: "pass", gate: "mandatory",
        detail: `grill_completed_at=${f.grill_completed_at}, depth=${depth} (from features row fallback)`,
      };
    }
    return {
      point: 6, name: "grill_gate", result: "fail", gate: "mandatory",
      detail: `grill depth ${depth} < required 4 (features row fallback)`,
    };
  }

  return {
    point: 6, name: "grill_gate", result: "fail", gate: "mandatory",
    detail: "no grill decisions found in grill_decisions table or features row",
  };
}

async function checkNoOverlap(f: FeatureRow): Promise<CheckOutcome> {
  const clauseIds = (f.clauses ?? []).filter((c) => typeof c === "string");
  if (clauseIds.length === 0) {
    return {
      point: 7, name: "no_overlap", result: "pass", gate: "soft",
      detail: "feature has no clauses yet — nothing to overlap",
    };
  }
  const sb = getSupabaseClient();
  const { data, error } = await sb
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
  // All checks run in parallel — both mandatory gates are now async (DB queries).
  const [c1, c2, c3, c4, c5, c6, c7] = await Promise.all([
    checkCanonicalRepo(project),
    checkStagingBranch(project),
    checkDeployConfig(project),
    checkCredentials(project),
    checkArchitectureGate(feature, project),
    checkGrillGate(feature, project),
    checkNoOverlap(feature),
  ]);

  const outcomes: CheckOutcome[] = [c1, c2, c3, c4, c5, c6, c7];
  const blocking_failures = outcomes.filter((o) => o.result === "fail");
  const mandatory_gates_pass =
    c5.result !== "fail" && c6.result !== "fail";
  const all_pass = blocking_failures.length === 0;

  return { outcomes, all_pass, mandatory_gates_pass, blocking_failures };
}
