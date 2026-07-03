// scoper/src/errors.ts
// AGT.SCOPER.SEAM_CLAUSE.1 — typed error hierarchy for Scoper prerequisite failures.
//
// PrereqError is thrown by validators that gate a plan from proceeding. It carries
// a machine-readable `code` and (when applicable) the offending `clause_id` so the
// caller (plan.ts) can decide whether to escalate to Mode B (findings) or Mode C
// (structural block) without re-parsing an error message.
//
// AGT.SCOPER.SEAM_CLAUSE.3 — SeamACViolationError added for the post-synthesis
// gate that rejects seam clauses carrying UI ACs whose verification is not
// 'deployed-pixel'. Distinct class from PrereqError because the gate fires
// after decomposition (not before), and callers need to distinguish "plan
// cannot start" (PrereqError) from "plan cannot be emitted" (SeamACViolationError).

export type PrereqErrorCode =
  | "component_clause_missing_mount_target";

export interface PrereqErrorDetail {
  clause_id?: string;
  clause_type?: string;
  [k: string]: unknown;
}

export class PrereqError extends Error {
  readonly code: PrereqErrorCode;
  readonly clause_id: string | null;
  readonly detail: PrereqErrorDetail;

  constructor(code: PrereqErrorCode, message: string, detail: PrereqErrorDetail = {}) {
    super(message);
    this.name = "PrereqError";
    this.code = code;
    this.clause_id = typeof detail.clause_id === "string" ? detail.clause_id : null;
    this.detail = detail;
  }
}

export function isPrereqError(err: unknown): err is PrereqError {
  return err instanceof PrereqError;
}

// ─── AGT.SCOPER.SEAM_CLAUSE.3 ───────────────────────────────────────────────
// Thrown by the post-synthesis seam AC gate when a clause with
// clause_type='seam' carries a UI-referencing AC whose verification is not
// 'deployed-pixel'. The error identifies both the clause_id and the acId of
// the FIRST offending AC so the caller can surface a narrow fix hint.

export type SeamACViolationCode = "seam_ac_non_deployed_pixel";

export class SeamACViolationError extends Error {
  readonly code: SeamACViolationCode;
  readonly clause_id: string;
  readonly acId: string;

  constructor(clause_id: string, acId: string, message: string) {
    super(message);
    this.name = "SeamACViolationError";
    this.code = "seam_ac_non_deployed_pixel";
    this.clause_id = clause_id;
    this.acId = acId;
  }
}

export function isSeamACViolationError(err: unknown): err is SeamACViolationError {
  return err instanceof SeamACViolationError;
}
