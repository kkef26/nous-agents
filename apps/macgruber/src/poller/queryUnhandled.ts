/**
 * queryUnhandled — find dispatch failures that never reached MacGruber.
 *
 * Joins nous.dispatch_events and nous.dispatch_queue against nous.fix_registry
 * and returns any failure row that lacks a corresponding action audit entry.
 * The LATERAL anti-join is the gap detector; without it, push events that
 * arrived normally would loop and inflate recurrence_count.
 *
 * The query is parameterised — no string concat — per clause constraint.
 */

import type { ParamQueryClient } from '../lib/db.js';

export interface UnhandledFailure {
  source: 'dispatch_events' | 'dispatch_queue';
  intake_event_id: string;
  dispatch_id: string | null;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  failure_class: string;
  detected_at: string;
  detail: Record<string, unknown> | null;
}

export interface QueryUnhandledOptions {
  limit?: number;
  lookbackMinutes?: number;
  project?: string;
}

const QUERY_SQL = `
  WITH event_failures AS (
    SELECT
      'dispatch_events'::text AS source,
      de.id::text AS intake_event_id,
      de.dispatch_id::text AS dispatch_id,
      dq.clause_id AS clause_id,
      dq.id::text AS run_id,
      dq.project AS project,
      COALESCE(dq.failure_class, de.verdict, 'unknown') AS failure_class,
      de.created_at AS detected_at,
      de.detail AS detail
    FROM nous.dispatch_events de
    JOIN nous.dispatch_queue dq ON dq.id = de.dispatch_id
    WHERE de.event_type IN ('fail', 'failure', 'error', 'failed')
      AND de.created_at >= now() - ($1 || ' minutes')::interval
      AND ($2::text IS NULL OR dq.project = $2)
  ),
  queue_failures AS (
    SELECT
      'dispatch_queue'::text AS source,
      dq.id::text AS intake_event_id,
      dq.id::text AS dispatch_id,
      dq.clause_id AS clause_id,
      dq.id::text AS run_id,
      dq.project AS project,
      COALESCE(dq.failure_class, dq.status, 'unknown') AS failure_class,
      dq.updated_at AS detected_at,
      jsonb_build_object('error', dq.error, 'status', dq.status) AS detail
    FROM nous.dispatch_queue dq
    WHERE dq.status IN ('failed', 'error', 'blocked')
      AND dq.updated_at >= now() - ($1 || ' minutes')::interval
      AND ($2::text IS NULL OR dq.project = $2)
  ),
  all_failures AS (
    SELECT * FROM event_failures
    UNION ALL
    SELECT * FROM queue_failures
  )
  SELECT f.source,
         f.intake_event_id,
         f.dispatch_id,
         f.clause_id,
         f.run_id,
         f.project,
         f.failure_class,
         f.detected_at,
         f.detail
  FROM all_failures f
  WHERE NOT EXISTS (
    SELECT 1
    FROM nous.fix_registry fr
    WHERE fr.fix_type = 'action'
      AND fr.run_id::text = f.run_id
  )
  ORDER BY f.detected_at ASC
  LIMIT $3
`;

export async function queryUnhandledFailures(
  client: ParamQueryClient,
  options: QueryUnhandledOptions = {},
): Promise<UnhandledFailure[]> {
  const lookback = options.lookbackMinutes ?? 60;
  const project = options.project ?? null;
  const limit = options.limit ?? 50;
  const { rows } = await client.query<UnhandledFailure>(QUERY_SQL, [
    String(lookback),
    project,
    limit,
  ]);
  return rows;
}
