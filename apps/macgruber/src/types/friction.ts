/**
 * Friction and decision_queue payload shapes.
 *
 * FrictionRow mirrors the nous.friction columns that MacGruber reads or
 * writes. DecisionQueuePayload is the structured payload handed off to
 * nous.decision_queue when the circuit breaker exhausts its budget.
 */

export interface FrictionInput {
  project: string;
  failure_class: string;
  root_cause: string;
  proposed_fix: string;
  quote?: string;
  severity?: number;
  tags?: string[];
}

export interface FrictionRow {
  id: string;
  project: string;
  category: string;
  reported_by: string;
  root_cause: string | null;
  proposed_fix: string | null;
  quote: string | null;
  severity: number | null;
  recurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  tags: string[] | null;
}

export interface CircuitBreakerSnapshot {
  attempts: number;
  max_attempts: number;
  exhausted: boolean;
  failure_class: string;
}

export interface InvestigationReport {
  intake_event_id: string;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  failure_class: string;
  root_cause: string;
  proposed_fix: string;
  attempts: Array<{
    attempt: number;
    started_at: string;
    completed_at: string | null;
    outcome: 'success' | 'failure';
    note?: string;
  }>;
  fix_registry_ids: string[];
  friction_id: string | null;
}

export interface DecisionQueuePayload {
  dispatch_id: string | null;
  agent_id: string;
  project: string;
  bible_clause: string | null;
  question: string;
  context: InvestigationReport & { intake_event_id: string };
  urgency: 'low' | 'normal' | 'high';
}
