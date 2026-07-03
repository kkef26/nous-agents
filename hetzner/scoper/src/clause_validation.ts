// scoper/src/clause_validation.ts
// AGT.SCOPER.SEAM_CLAUSE.1 — clause-level prerequisite gate.
//
// The 7-point prerequisite check in prerequisites.ts runs at the FEATURE level
// (canonical_repo, staging branch, credentials, architecture doc, grill depth, …)
// BEFORE any clauses exist. This module runs at the CLAUSE level AFTER
// decomposition has produced a clause set, right before wave organization and
// dispatch. It exists to enforce that every `clause_type === 'component'` clause
// declares a machine-readable `mount_target`, so the seam-clause system
// (deployed-pixel verifier + integration-clause author) has a wiring manifest
// instead of archaeology (per grill decision "arch: component clauses must
// declare their intended mount point in a machine-readable field").
//
// Contract:
//   - Pure function of the clause array; no I/O, no db.
//   - Non-component clauses are UNTOUCHED — they may or may not have mount_target.
//   - A component clause with a whitespace-only mount_target counts as missing.
//   - On the FIRST violation encountered, throws `PrereqError` with
//     code='component_clause_missing_mount_target' and the offending clause_id
//     in `detail`. We fail-fast on the first offender to keep the error surface
//     narrow — the caller can re-run after fixing it.
//   - Callers MUST NOT catch this error inside checkPrerequisites; it is
//     designed to propagate to the plan orchestrator (see CONSTRAINTS in clause
//     body).

import type { ClauseSpec } from "./decomposition.js";
import { PrereqError } from "./errors.js";

export const COMPONENT_CLAUSE_TYPE = "component" as const;

export interface MountTargetValidatable {
  id: string;
  clause_type: string;
  mount_target?: string;
}

function hasMountTarget(clause: MountTargetValidatable): boolean {
  const mt = clause.mount_target;
  if (typeof mt !== "string") return false;
  return mt.trim().length > 0;
}

/**
 * Iterates `clauses` and throws `PrereqError` on the FIRST component clause
 * missing a non-empty `mount_target`. Non-component clauses are ignored.
 *
 * Returns void when every component clause has a mount_target (or when the
 * plan contains zero component clauses).
 */
export function validateClauseMountTargets(clauses: readonly MountTargetValidatable[]): void {
  for (const clause of clauses) {
    if (clause.clause_type !== COMPONENT_CLAUSE_TYPE) continue;
    if (hasMountTarget(clause)) continue;
    throw new PrereqError(
      "component_clause_missing_mount_target",
      `Clause ${clause.id} has clause_type='component' but is missing a mount_target. ` +
      `Component clauses MUST declare a route path, component display name, or CSS selector so the seam clause has a wiring manifest.`,
      { clause_id: clause.id, clause_type: clause.clause_type },
    );
  }
}

/**
 * Non-throwing variant that returns a list of offending clause ids instead of
 * throwing. Used by test suites that assert coverage across an entire plan in
 * one pass; production plan orchestration should use the throwing variant.
 */
export function findComponentClausesMissingMountTarget(
  clauses: readonly MountTargetValidatable[],
): string[] {
  const offenders: string[] = [];
  for (const clause of clauses) {
    if (clause.clause_type !== COMPONENT_CLAUSE_TYPE) continue;
    if (!hasMountTarget(clause)) offenders.push(clause.id);
  }
  return offenders;
}

// Re-export the ClauseSpec-shaped signature so plan.ts can pass its
// `decomposition.clauses` array without loosening the type at the call site.
export type ClauseForMountTargetGate = Pick<ClauseSpec, "id" | "clause_type" | "mount_target">;
