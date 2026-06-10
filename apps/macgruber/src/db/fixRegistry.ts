/**
 * Insert and query helpers for the fix_registry action audit trail.
 *
 * Every MacGruber executor call writes exactly one fix_registry row recording
 * the action attempted and its structured ActionResult. Rows tagged with
 * created_by='macgruber' and fix_type='action' constitute the action log used
 * by the escalation path in FEAT.MACGRUBER.7.
 *
 * Per clause constraint: only executeAction() writes here. Clients never do.
 */

import type { FixAction, ActionResult } from '../executors/types.js';

export interface FixRegistryRow {
  id: string;
  clause_id: string | null;
  run_id: string | null;
  project: string;
  action: string;
  action_payload: FixAction;
  action_result: ActionResult;
  executed_at: string;
  created_by: string;
}

export interface FixRegistryInsert {
  clause_id: string | null;
  run_id: string | null;
  project: string;
  action: FixAction;
  result: ActionResult;
  recorded_by: string;
}

/**
 * Minimal parameterised query interface. Shared DB client lives in
 * apps/macgruber/src/lib/db.ts (FEAT.MACGRUBER.2). We only depend on the
 * type-narrow contract here so this module remains test-friendly.
 */
export interface ParamQueryClient {
  query<R = unknown>(text: string, params: unknown[]): Promise<{ rows: R[] }>;
}

const INSERT_SQL = `
  INSERT INTO nous.fix_registry (
    project,
    failure_description,
    change_made,
    verification_metric,
    status,
    created_by,
    fix_type,
    clause_id,
    run_id,
    action,
    action_result,
    executed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
  RETURNING id, executed_at
`;

export async function recordAction(
  client: ParamQueryClient,
  insert: FixRegistryInsert,
): Promise<{ id: string; executed_at: string }> {
  const description = `${insert.action.kind} (${insert.result.success ? 'ok' : 'fail'})`;
  const status = insert.result.success ? 'executed' : 'failed';
  const params: unknown[] = [
    insert.project,
    description,
    JSON.stringify(insert.action),
    JSON.stringify(insert.result),
    status,
    insert.recorded_by,
    'action',
    insert.clause_id,
    insert.run_id,
    insert.action.kind,
    JSON.stringify(insert.result),
  ];
  const { rows } = await client.query<{ id: string; executed_at: string }>(INSERT_SQL, params);
  if (rows.length === 0) {
    throw new Error('fix_registry insert returned no rows');
  }
  return rows[0];
}

const SELECT_BY_CLAUSE_SQL = `
  SELECT
    id,
    clause_id,
    run_id,
    project,
    action,
    change_made AS action_payload,
    action_result,
    executed_at,
    created_by
  FROM nous.fix_registry
  WHERE clause_id = $1
    AND fix_type = 'action'
  ORDER BY executed_at ASC
`;

export async function listActionsForClause(
  client: ParamQueryClient,
  clauseId: string,
): Promise<FixRegistryRow[]> {
  const { rows } = await client.query<FixRegistryRow>(SELECT_BY_CLAUSE_SQL, [clauseId]);
  return rows;
}

const SELECT_BY_RUN_SQL = `
  SELECT
    id,
    clause_id,
    run_id,
    project,
    action,
    change_made AS action_payload,
    action_result,
    executed_at,
    created_by
  FROM nous.fix_registry
  WHERE run_id = $1
    AND fix_type = 'action'
  ORDER BY executed_at ASC
`;

export async function listActionsForRun(
  client: ParamQueryClient,
  runId: string,
): Promise<FixRegistryRow[]> {
  const { rows } = await client.query<FixRegistryRow>(SELECT_BY_RUN_SQL, [runId]);
  return rows;
}
