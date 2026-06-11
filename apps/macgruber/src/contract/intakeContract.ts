/**
 * MacGruber intake contract — the single source of truth for what producers
 * (Conductor, Scoper, the poller) send to POST /intake.
 *
 * Schema v2 (2026-06-11) is conductor-canon: required fields are exactly what
 * hetzner/conductor-v4/src/macgruber.ts already sends. The retired v1 schema
 * (error_message/step_attempted/repo/branch/sha/prior_attempts) rejected 100%
 * of conductor traffic — every push 400'd and was swallowed by
 * fire-and-forget. Do not resurrect it.
 */

import { randomUUID } from 'node:crypto';

export const INTAKE_SCHEMA_VERSION = 2;

/** Failure classes the pipeline actually emits (conductor + remora + reaper). */
export const KNOWN_FAILURE_CLASSES = [
  'branch_not_found',
  'workspace_error',
  'stale_verifying',
  'stale_branch',
  'stale_orphan',
  'no_build_artifacts',
  'gate_failure',
  'merge_conflict',
  'merge_api_error',
  'exhausted_attempts',
  'stall_no_heartbeat',
  'stall_no_progress',
  'silent_death',
  'zombie_cleanup',
  'unknown',
] as const;

export type KnownFailureClass = (typeof KNOWN_FAILURE_CLASSES)[number];

/** Open union: known classes get autocomplete; unknown strings still flow. */
export type FailureClass = KnownFailureClass | (string & {});

/**
 * Classes MacGruber remediates mechanically (cancel dead row + retrigger
 * tree). Everything else escalates to nous.decision_queue. No LLM is needed
 * for these: the fix is deterministic.
 */
export const MECHANICAL_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'branch_not_found',
  'workspace_error',
  'stale_verifying',
  'stale_branch',
  'stale_orphan',
  'no_build_artifacts',
  'exhausted_attempts',
  'stall_no_heartbeat',
  'stall_no_progress',
  'silent_death',
]);

export interface IntakeEventShape {
  intake_event_id: string;
  source: 'push' | 'poll';
  dispatch_id: string | null;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  failure_class: string;
  raw: Record<string, unknown>;
}

export interface ContractParseOk {
  ok: true;
  event: IntakeEventShape;
}

export interface ContractParseErr {
  ok: false;
  error: 'invalid_payload';
  failing_fields: Array<{ path: string; message: string }>;
}

export type ContractParseResult = ContractParseOk | ContractParseErr;

/**
 * Parse a raw HTTP body into an intake event. Only `project` and
 * `failure_class` are hard-required — everything Conductor knows at failure
 * time. `intake_event_id` is generated server-side when absent so producers
 * never have to mint one.
 */
export function parseIntakeBody(
  body: unknown,
  opts?: { uuid?: () => string },
): ContractParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_payload',
      failing_fields: [{ path: '(root)', message: 'body must be a JSON object' }],
    };
  }
  const b = body as Record<string, unknown>;
  const failing: Array<{ path: string; message: string }> = [];
  if (typeof b.project !== 'string' || b.project.length === 0) {
    failing.push({ path: 'project', message: 'project is required' });
  }
  if (typeof b.failure_class !== 'string' || b.failure_class.length === 0) {
    failing.push({ path: 'failure_class', message: 'failure_class is required' });
  }
  if (failing.length > 0) {
    return { ok: false, error: 'invalid_payload', failing_fields: failing };
  }
  const uuid = opts?.uuid ?? randomUUID;
  const intakeEventId =
    typeof b.intake_event_id === 'string' && b.intake_event_id.length > 0
      ? b.intake_event_id
      : uuid();
  const detail =
    typeof b.detail === 'object' && b.detail !== null && !Array.isArray(b.detail)
      ? (b.detail as Record<string, unknown>)
      : {};
  return {
    ok: true,
    event: {
      intake_event_id: intakeEventId,
      source: b.source === 'poll' ? 'poll' : 'push',
      dispatch_id: typeof b.dispatch_id === 'string' ? b.dispatch_id : null,
      clause_id: typeof b.clause_id === 'string' ? b.clause_id : null,
      run_id: typeof b.run_id === 'string' ? b.run_id : null,
      project: b.project as string,
      failure_class: b.failure_class as string,
      raw: { ...b, detail },
    },
  };
}
