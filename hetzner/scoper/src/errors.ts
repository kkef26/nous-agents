// scoper/src/errors.ts
// AGT.SCOPER.SEAM_CLAUSE.1 — typed error hierarchy for Scoper prerequisite failures.
//
// PrereqError is thrown by validators that gate a plan from proceeding. It carries
// a machine-readable `code` and (when applicable) the offending `clause_id` so the
// caller (plan.ts) can decide whether to escalate to Mode B (findings) or Mode C
// (structural block) without re-parsing an error message.

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
