// scoper/src/seam_ac_gate.ts
// AGT.SCOPER.SEAM_CLAUSE.3 — post-synthesis gate that rejects seam clauses
// carrying UI ACs whose verification is not 'deployed-pixel'.
//
// Rationale (feature brief): seam clauses own mount-point wiring — the only
// way to verify wiring landed is on the deployed artefact. A seam clause AC
// with verification='auto' (file-regex, curl, SQL) or 'physical_qa' cannot
// prove that the mount happened; it can only prove that source files
// contain a symbol or that a human eyeballed a screen. Both leave the
// orphaned-component failure mode wide open (see grill decision "arch: Every
// dispatch tree for a UI-touching feature ENDS with a mandatory integration
// (seam) clause…" and the CRITICAL BOARD_UNIFY orphan incident).
//
// Contract:
//   - Pure function of the clause array; no I/O, no db.
//   - Only clauses with clause_type === 'seam' are checked.
//   - An AC on a seam clause triggers the gate ONLY when its text references
//     a UI element (heuristic keyword match). Non-UI ACs on a seam clause
//     (e.g. "route_registry contains the entry") are permitted with any
//     verification type.
//   - When triggered, throws `SeamACViolationError` with the clause_id AND
//     acId of the FIRST offending AC. The caller is decomposition.ts, which
//     invokes the gate immediately before returning the dispatch tree.
//   - Callers MUST NOT catch this error inside decomposition; it is designed
//     to propagate to the plan orchestrator so Mode B rescoping fires.

import type { AcceptanceCriterion } from "./decomposition.js";
import { DEPLOYED_PIXEL_VERIFICATION } from "./decomposition.js";
import { SeamACViolationError } from "./errors.js";

export const SEAM_CLAUSE_TYPE = "seam" as const;

export interface SeamACValidatable {
  id: string;
  clause_type: string;
  acceptance_criteria: AcceptanceCriterion[];
}

// UI-referencing keyword list. Case-insensitive substring match.
// Deliberately narrow: only terms that unambiguously refer to rendered UI.
// "endpoint", "column", "response" stay OFF the list — a seam clause may
// legitimately assert a non-UI invariant with `auto`.
const UI_KEYWORDS: readonly string[] = [
  "render",   // renders, rendered, rendering
  "visible",
  "element",
  "mount",    // mount, mounted, mounts
  "dom",
  "selector",
  "displayed",
  "shown",
  "page",
  "component",
  "wiring",
];

function acReferencesUI(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of UI_KEYWORDS) {
    // Word-adjacent match: allow substring so "renders"/"rendered" both hit
    // on keyword "render". Cheap and covers the observed shape of seam ACs.
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Iterates `clauses` and throws `SeamACViolationError` on the FIRST AC of a
 * seam clause that references a UI element and does NOT use
 * verification='deployed-pixel'. Non-seam clauses are ignored; UI-referencing
 * ACs on non-seam clauses are permitted.
 *
 * Returns void when every seam clause AC is well-formed.
 */
export function validateSeamClauseACs(clauses: readonly SeamACValidatable[]): void {
  for (const clause of clauses) {
    if (clause.clause_type !== SEAM_CLAUSE_TYPE) continue;
    for (const ac of clause.acceptance_criteria) {
      if (!acReferencesUI(ac.text)) continue;
      if (ac.verification === DEPLOYED_PIXEL_VERIFICATION) continue;
      throw new SeamACViolationError(
        clause.id,
        ac.id,
        `Seam clause ${clause.id} carries UI-referencing AC ${ac.id} ` +
        `with verification='${ac.verification}'. Seam clauses may only ` +
        `verify UI wiring with verification='deployed-pixel' — file-regex ` +
        `and other local-check types cannot prove that mount-point wiring ` +
        `landed on the deployed artefact.`,
      );
    }
  }
}
