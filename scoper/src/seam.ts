// scoper/src/seam.ts
// AGT.SCOPER.SEAM_CLAUSE.2 — pure synthesis of a seam clause from component-clause metadata.
//
// The seam clause is the SOLE writer of shared mount points (App.tsx, route index files,
// application shells) for a given dispatch tree. It is injected as the final wave so that
// every component clause (which stays banned from touching shared files) has its declared
// mount_target wired in one serialized author.
//
// Contract:
//   - Pure function of a ClauseSpec[]; no I/O, no DB.
//   - Input array and clause objects are NEVER mutated.
//   - Only clauses with clause_type === 'component' contribute to wiring_manifest.
//   - Duplicate mount_target strings are deduplicated (first-seen wins).
//   - The synthesized seam clause requires[] lists every component clause id.
//   - Whitespace-only and missing mount_target values are dropped from the manifest
//     (the component-level validator in clause_validation.ts already rejects those
//     upstream; this function is defensive but does not throw on them).

import type { AcceptanceCriterion, ClauseContract, ClauseSpec } from "./decomposition.js";

export const SEAM_CLAUSE_TYPE = "seam" as const;
export const COMPONENT_CLAUSE_TYPE = "component" as const;

/**
 * SeamClause is a ClauseSpec whose clause_type is fixed to the "seam" literal
 * and which carries a machine-readable wiring_manifest listing every shared
 * mount point the seam clause exclusively owns.
 */
export interface SeamClause extends ClauseSpec {
  clause_type: typeof SEAM_CLAUSE_TYPE;
  wiring_manifest: string[];
}

function isComponentClause(c: Pick<ClauseSpec, "clause_type">): boolean {
  return c.clause_type === COMPONENT_CLAUSE_TYPE;
}

function isSeamClause(c: Pick<ClauseSpec, "clause_type">): boolean {
  return c.clause_type === SEAM_CLAUSE_TYPE;
}

function collectMountTargets(componentClauses: readonly ClauseSpec[]): string[] {
  const seen = new Set<string>();
  const manifest: string[] = [];
  for (const c of componentClauses) {
    const raw = typeof c.mount_target === "string" ? c.mount_target.trim() : "";
    if (raw.length === 0 || seen.has(raw)) continue;
    seen.add(raw);
    manifest.push(raw);
  }
  return manifest;
}

const ANTIPATTERN_TEXT =
  "Do NOT declare shared mount points (App.tsx, route index files, or the application shell) " +
  "in a non-seam clause's contract.elements — the seam clause holds exclusive write authority " +
  "for these files. Component clauses declare a mount_target; the seam clause performs the wiring.";

/**
 * buildSeamClause synthesizes a single seam clause from the given component
 * clauses. Callers MUST pass at least one component clause; passing zero
 * throws because there is nothing to wire.
 *
 * The result is a NEW object; input clauses are not read for anything beyond
 * their id, prefix, feature_id, mount_target, and sequence_order fields, and
 * are never mutated.
 */
export function buildSeamClause(componentClauses: readonly ClauseSpec[]): SeamClause {
  if (componentClauses.length === 0) {
    throw new Error("buildSeamClause: componentClauses must contain at least one clause");
  }

  const wiring_manifest = collectMountTargets(componentClauses);
  const requires = componentClauses.map((c) => c.id);
  const firstPrefix = componentClauses[0].prefix;
  const featureId = componentClauses[0].feature_id;
  const highestSeq = componentClauses.reduce(
    (max, c) => (c.sequence_order > max ? c.sequence_order : max),
    0,
  );

  const manifestBullets = wiring_manifest.length > 0
    ? wiring_manifest.map((m) => `- ${m}`).join("\n")
    : "- (no mount_target values declared by component clauses)";

  const acceptance_criteria: AcceptanceCriterion[] = [
    {
      id: "AC01",
      text:
        `Every component clause listed in \`requires\` (${requires.length}) is mounted at its ` +
        `declared mount_target on the deployed URL — verified via headless DOM query or screenshot.`,
      verification: "physical_qa",
      form: "technical_spec",
    },
    {
      id: "AC02",
      text:
        `Only the seam clause writes the shared mount points listed in \`wiring_manifest\` ` +
        `(${wiring_manifest.length} entries); no non-seam clause touches App.tsx, route index ` +
        `files, or the application shell.`,
      verification: "auto",
      form: "technical_spec",
    },
  ];

  const contract: ClauseContract = {
    elements: wiring_manifest.map((mt, i) => ({
      id: `E${String(i + 1).padStart(2, "0")}`,
      kind: "mount_point",
      name: mt,
    })),
    exclusions: [
      {
        kind: "antipattern",
        name: "shared_mount_point_declaration_outside_seam",
        prior: ANTIPATTERN_TEXT,
      },
    ],
    antipatterns: [{ id: "AP01", text: ANTIPATTERN_TEXT }],
    verification: [
      {
        target: "AC02",
        method: "grep",
        command:
          "git diff --name-only main...HEAD | xargs -I{} grep -l 'mount_point' {} 2>/dev/null",
        expect: "Only files owned by the seam clause appear in the shared-mount-point diff",
      },
    ],
  };

  const seam: SeamClause = {
    id: `${firstPrefix}.SEAM`,
    prefix: firstPrefix,
    parent_id: null,
    title: "Seam: wire component mount points",
    feature_id: featureId,
    sequence_order: highestSeq + 1,
    maturity_stage: "SCAFFOLD",
    status: "draft",
    clause_type: SEAM_CLAUSE_TYPE,
    critical_path: true,
    requires,
    enables: [],
    acceptance_criteria,
    body:
      `## Why\n` +
      `Component clauses are banned from writing shared mount points (App.tsx, route index files, ` +
      `application shells) so they can run in parallel without merge conflicts. The seam clause ` +
      `is the SOLE writer of those shared files, serialized in the final wave.\n\n` +
      `## What\n` +
      `Wire every component clause listed in \`requires\` into its declared \`mount_target\`. ` +
      `This clause is the ONLY author of the files that host the mount points listed in the ` +
      `wiring manifest below.\n\n` +
      `## How\n` +
      `For each entry in the wiring manifest, add the import + render call in the appropriate ` +
      `shell file. Preserve the manifest order so wave-level determinism holds across replays.\n\n` +
      `## Wiring Manifest\n${manifestBullets}\n`,
    contract,
    wiring_manifest,
  };

  return seam;
}

/**
 * injectSeamClause returns a NEW clause array with a synthesized seam clause
 * appended if the input contains one or more component clauses. Idempotent:
 * if the input already contains a seam clause OR has zero component clauses,
 * the returned array is a shallow copy of the input with no synthesized seam.
 *
 * The input array and its clause objects are NEVER mutated.
 */
export function injectSeamClause(clauses: readonly ClauseSpec[]): ClauseSpec[] {
  if (clauses.some(isSeamClause)) return [...clauses];
  const componentClauses = clauses.filter(isComponentClause);
  if (componentClauses.length === 0) return [...clauses];
  const seam = buildSeamClause(componentClauses);
  return [...clauses, seam];
}
