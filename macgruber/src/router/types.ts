import type { FailureClass, IntakePayload } from '../schemas/intakePayload.js';

export type { FailureClass };

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

export interface InvestigationContext {
  intakeId: string;
  payload: IntakePayload;
  clauseHistory: ReadonlyArray<{
    attempted_at: string;
    failure_class: string;
    outcome: string | null;
  }>;
  githubContext: {
    repo: string;
    branch: string;
    sha: string;
  };
}

export interface FixStrategy {
  summary: string;
  approach: 'amend_inline' | 'rescope_clause' | 'manual_review' | 'defer';
  files_to_modify: ReadonlyArray<{ path: string; reason: string }>;
  estimated_risk: SeverityLevel;
  notes?: string;
}

export interface InvestigationResult {
  investigationId: string;
  severity: SeverityLevel;
  handler: FailureClass;
  fixStrategy: FixStrategy | null;
  sonnetInvoked: boolean;
}
