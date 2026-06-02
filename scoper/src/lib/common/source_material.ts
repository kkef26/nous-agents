// hetzner/scoper/src/lib/common/source_material.ts
// PIPE.CLEANUP Wave 1 — Shared helper for querying nous.feature_source_material view.
// Used by prerequisites.ts (grill + architecture gates) and decomposition.ts (enrichment context).
// Per grill decision D3: query source tables directly, not features row derived fields.
// Per grill decision D6: feature_source_material is a Postgres view unioning
// grill_decisions + library_artifacts (architecture, grill_resolution) + prototype decisions.

import { getSupabaseClient } from "./db.js";

// ─── Row shape (mirrors the Postgres view columns) ───────────────────────────

export type SourceType =
  | "grill_decision"
  | "grill_decision_project"
  | "architecture"
  | "grill_resolution"
  | "prototype_decision";

export interface SourceMaterialRow {
  feature_id: string | null;
  project: string | null;
  source_type: SourceType;
  source_id: string;
  title: string | null;
  content: string | null;
  category: string | null;
  severity: string | null;
  created_at: string | null;
}

// ─── Structured output ───────────────────────────────────────────────────────

export interface FeatureSourceMaterial {
  grill_decisions: SourceMaterialRow[];
  project_grill_decisions: SourceMaterialRow[];
  architecture_docs: SourceMaterialRow[];
  grill_resolutions: SourceMaterialRow[];
  prototype_decisions: SourceMaterialRow[];
  /** Total grill decisions (feature-specific + project-wide) */
  grill_count: number;
  /** Whether any architecture doc exists for this project */
  has_architecture: boolean;
}

// ─── Main query ──────────────────────────────────────────────────────────────

/**
 * Load all source material for a feature + project.
 *
 * Queries feature_source_material view with two filter paths:
 *   1. feature_id = featureId (feature-specific grill decisions)
 *   2. project = project (project-wide decisions, architecture, resolutions, prototypes)
 *
 * Returns structured object bucketed by source_type.
 */
export async function loadFeatureSourceMaterial(
  featureId: string,
  project: string,
): Promise<FeatureSourceMaterial> {
  const sb = getSupabaseClient();

  // Two-pass query: feature-specific decisions are scoped tightly;
  // project-wide material (architecture, resolutions) is included as context.
  // This prevents other features' grill decisions from polluting the scope.
  const [featureResult, projectResult] = await Promise.all([
    // Pass 1: feature-specific grill decisions only
    sb.from("feature_source_material")
      .select("feature_id, project, source_type, source_id, title, content, category, severity, created_at")
      .eq("feature_id", featureId)
      .order("created_at", { ascending: true }),
    // Pass 2: project-wide material (non-feature-specific: architecture docs, resolutions, project-wide grills)
    sb.from("feature_source_material")
      .select("feature_id, project, source_type, source_id, title, content, category, severity, created_at")
      .eq("project", project)
      .is("feature_id", null)
      .order("created_at", { ascending: true }),
  ]);

  const error = featureResult.error || projectResult.error;
  const data = [...(featureResult.data ?? []), ...(projectResult.data ?? [])];

  if (error) {
    throw new Error(`loadFeatureSourceMaterial: ${error.message}`);
  }

  const rows = (data ?? []) as SourceMaterialRow[];

  const grill_decisions: SourceMaterialRow[] = [];
  const project_grill_decisions: SourceMaterialRow[] = [];
  const architecture_docs: SourceMaterialRow[] = [];
  const grill_resolutions: SourceMaterialRow[] = [];
  const prototype_decisions: SourceMaterialRow[] = [];

  for (const row of rows) {
    switch (row.source_type) {
      case "grill_decision":
        grill_decisions.push(row);
        break;
      case "grill_decision_project":
        project_grill_decisions.push(row);
        break;
      case "architecture":
        architecture_docs.push(row);
        break;
      case "grill_resolution":
        grill_resolutions.push(row);
        break;
      case "prototype_decision":
        prototype_decisions.push(row);
        break;
    }
  }

  const grill_count = grill_decisions.length + project_grill_decisions.length;
  const has_architecture = architecture_docs.length > 0;

  return {
    grill_decisions,
    project_grill_decisions,
    architecture_docs,
    grill_resolutions,
    prototype_decisions,
    grill_count,
    has_architecture,
  };
}

/**
 * Quick grill-only count. Lighter than full loadFeatureSourceMaterial when
 * you only need the gate check (prerequisites.ts).
 *
 * Queries grill_decisions table directly — faster, no joins with library_artifacts.
 */
export async function countGrillDecisions(
  featureId: string,
  project: string,
): Promise<{ count: number; featureSpecific: number; projectWide: number }> {
  const sb = getSupabaseClient();

  // Feature-specific decisions
  const { count: featureCount, error: e1 } = await sb
    .from("grill_decisions")
    .select("id", { count: "exact", head: true })
    .eq("feature_id", featureId);

  if (e1) throw new Error(`countGrillDecisions (feature): ${e1.message}`);

  // Project-wide decisions (feature_id is null, project matches)
  const { count: projectCount, error: e2 } = await sb
    .from("grill_decisions")
    .select("id", { count: "exact", head: true })
    .is("feature_id", null)
    .eq("project", project);

  if (e2) throw new Error(`countGrillDecisions (project): ${e2.message}`);

  const featureSpecific = featureCount ?? 0;
  const projectWide = projectCount ?? 0;

  return {
    count: featureSpecific + projectWide,
    featureSpecific,
    projectWide,
  };
}

/**
 * Quick architecture-only check. Returns true if ANY architecture doc
 * exists in library_artifacts for this project.
 */
export async function hasArchitectureDoc(project: string): Promise<boolean> {
  const sb = getSupabaseClient();

  const { count, error } = await sb
    .from("library_artifacts")
    .select("id", { count: "exact", head: true })
    .contains("tags", ["architecture"])
    .eq("project", project);

  if (error) throw new Error(`hasArchitectureDoc: ${error.message}`);

  return (count ?? 0) > 0;
}
