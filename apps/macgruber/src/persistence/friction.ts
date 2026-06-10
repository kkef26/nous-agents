/**
 * Friction persistence — captures every remediation attempt as a learning
 * record. Constraints:
 *  - writeFriction never throws; DB errors degrade gracefully and log to stderr
 *  - one row per (failure_class, reported_by, project); recurrence is
 *    tracked by incrementing recurrence_count on the existing row
 *  - all SQL is parameterised through the shared ParamQueryClient
 *
 * The friction table has no failure_class column, so we tag rows with
 * category='macgruber-failure' and persist the failure class under the
 * tags array as 'class:<value>'. The upsert key is therefore
 * (project, reported_by, category, tags @> ARRAY['class:<value>']).
 */

import type { ParamQueryClient } from '../lib/db.js';
import type { FrictionInput, FrictionRow } from '../types/friction.js';

export const MACGRUBER_REPORTED_BY = 'macgruber';
export const MACGRUBER_CATEGORY = 'macgruber-failure';

export interface WriteFrictionResult {
  ok: boolean;
  friction_id: string | null;
  recurrence_count: number | null;
  inserted: boolean;
  error?: string;
}

const SELECT_EXISTING_SQL = `
  SELECT id, recurrence_count
  FROM nous.friction
  WHERE project = $1
    AND reported_by = $2
    AND category = $3
    AND tags @> ARRAY[$4]::text[]
  FOR UPDATE
  LIMIT 1
`;

const INCREMENT_EXISTING_SQL = `
  UPDATE nous.friction
  SET recurrence_count = recurrence_count + 1,
      last_seen_at = now(),
      root_cause = COALESCE($2, root_cause),
      proposed_fix = COALESCE($3, proposed_fix),
      quote = COALESCE($4, quote),
      severity = COALESCE($5, severity)
  WHERE id = $1
  RETURNING id, recurrence_count
`;

const INSERT_NEW_SQL = `
  INSERT INTO nous.friction (
    project,
    category,
    reported_by,
    root_cause,
    proposed_fix,
    quote,
    severity,
    recurrence_count,
    tags,
    first_seen_at,
    last_seen_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, now(), now())
  RETURNING id, recurrence_count
`;

/**
 * Upsert: increment recurrence_count if a matching row exists, else insert.
 *
 * Never throws. On DB error returns { ok: false, error } and logs to stderr.
 * Callers must treat friction writes as non-blocking signals.
 */
export async function upsertFriction(
  client: ParamQueryClient,
  input: FrictionInput,
): Promise<WriteFrictionResult> {
  try {
    const classTag = `class:${input.failure_class}`;
    const existing = await client.query<{ id: string; recurrence_count: number }>(
      SELECT_EXISTING_SQL,
      [input.project, MACGRUBER_REPORTED_BY, MACGRUBER_CATEGORY, classTag],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const updated = await client.query<{ id: string; recurrence_count: number }>(
        INCREMENT_EXISTING_SQL,
        [
          row.id,
          input.root_cause ?? null,
          input.proposed_fix ?? null,
          input.quote ?? null,
          input.severity ?? null,
        ],
      );
      const updatedRow = updated.rows[0] ?? row;
      return {
        ok: true,
        friction_id: updatedRow.id,
        recurrence_count: updatedRow.recurrence_count,
        inserted: false,
      };
    }

    const tags = mergeTags(input.tags, classTag);
    const inserted = await client.query<{ id: string; recurrence_count: number }>(
      INSERT_NEW_SQL,
      [
        input.project,
        MACGRUBER_CATEGORY,
        MACGRUBER_REPORTED_BY,
        input.root_cause,
        input.proposed_fix,
        input.quote ?? null,
        input.severity ?? null,
        tags,
      ],
    );
    if (inserted.rows.length === 0) {
      return { ok: false, friction_id: null, recurrence_count: null, inserted: false, error: 'insert returned no rows' };
    }
    const row = inserted.rows[0];
    return {
      ok: true,
      friction_id: row.id,
      recurrence_count: row.recurrence_count,
      inserted: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[macgruber] friction upsert failed: ${message}\n`);
    return { ok: false, friction_id: null, recurrence_count: null, inserted: false, error: message };
  }
}

/**
 * Alias for callers that prefer the simpler verb.
 */
export async function writeFriction(
  client: ParamQueryClient,
  input: FrictionInput,
): Promise<WriteFrictionResult> {
  return upsertFriction(client, input);
}

const SELECT_BY_CLASS_SQL = `
  SELECT id, project, category, reported_by, root_cause, proposed_fix, quote,
         severity, recurrence_count, first_seen_at, last_seen_at, tags
  FROM nous.friction
  WHERE project = $1
    AND reported_by = $2
    AND category = $3
    AND tags @> ARRAY[$4]::text[]
  LIMIT 1
`;

export async function findFrictionByClass(
  client: ParamQueryClient,
  project: string,
  failure_class: string,
): Promise<FrictionRow | null> {
  const classTag = `class:${failure_class}`;
  const { rows } = await client.query<FrictionRow>(SELECT_BY_CLASS_SQL, [
    project,
    MACGRUBER_REPORTED_BY,
    MACGRUBER_CATEGORY,
    classTag,
  ]);
  return rows[0] ?? null;
}

function mergeTags(extra: string[] | undefined, classTag: string): string[] {
  const base = new Set<string>(['macgruber']);
  if (extra) {
    for (const t of extra) base.add(t);
  }
  base.add(classTag);
  return Array.from(base);
}
