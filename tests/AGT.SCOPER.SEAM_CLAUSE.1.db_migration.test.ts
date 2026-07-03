// AGT.SCOPER.SEAM_CLAUSE.1 — DB migration structural tests.
//
// Covers:
//   AC05 — A versioned migration exists at migrations/010_add_mount_target.sql
//          that adds a nullable text `mount_target` column to
//          nous.bible_clauses with an idempotent guard (IF NOT EXISTS).
//          Non-component clauses remain valid — no CHECK / NOT NULL is added.
//
// Approach: this project applies migrations as raw SQL files pushed via
// GitHub API (Conductor applies them post-merge). There is no in-process
// migration runner to invoke, so this suite verifies the migration file's
// STRUCTURE — the invariants that make the migration safe to apply and
// safe to re-apply (idempotency, nullability, target table).

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(HERE, '..', 'migrations', '010_add_mount_target.sql');

describe('AC05 — migration file structural invariants', () => {
  it('migration file exists at migrations/010_add_mount_target.sql', () => {
    assert.ok(existsSync(MIGRATION_PATH), `missing migration file at ${MIGRATION_PATH}`);
  });

  it('migration adds a mount_target column to nous.bible_clauses', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // Case-insensitive match on the target table + column
    assert.match(sql, /alter\s+table\s+nous\.bible_clauses/i);
    assert.match(sql, /add\s+column\s+if\s+not\s+exists\s+mount_target\s+text/i);
  });

  it('migration is idempotent — uses IF NOT EXISTS guard', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    assert.match(sql, /if\s+not\s+exists/i,
      'migration must use IF NOT EXISTS so the runner may re-apply it safely');
  });

  it('migration does NOT add a NOT NULL constraint (column must be nullable for non-component clauses)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // We look for NOT NULL specifically on the mount_target column definition.
    // The migration may reference NOT NULL for other historical columns (in
    // COMMENT text), so we restrict the check to the ADD COLUMN clause.
    const addColMatch = sql.match(/add\s+column[^;]+mount_target[^;]+/i);
    assert.ok(addColMatch, 'expected an ADD COLUMN ... mount_target ... clause');
    const addColStmt = addColMatch![0];
    assert.doesNotMatch(addColStmt, /not\s+null/i,
      `mount_target must be nullable at DDL level; ADD COLUMN clause was: ${addColStmt}`);
  });

  it('migration does NOT add a CHECK constraint on mount_target', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // A CHECK on mount_target would over-constrain the value shape (route path
    // vs display name vs selector are intentionally overlapping strings).
    assert.doesNotMatch(sql, /check\s*\([^)]*mount_target[^)]*\)/i,
      'migration must not add a CHECK constraint on mount_target — value shape is intentionally open');
  });

  it('migration wraps its statements in a transaction (BEGIN … COMMIT)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    assert.match(sql, /begin\s*;/i);
    assert.match(sql, /commit\s*;/i);
  });

  it('migration filename follows the NNN_description.sql convention', () => {
    // Sanity check on the ordering — 010 slots after 009_macgruber_fix_registry.sql.
    const basename = MIGRATION_PATH.split('/').pop()!;
    assert.match(basename, /^010_[a-z0-9_]+\.sql$/,
      `expected filename to match ^010_[a-z0-9_]+\\.sql$, got ${basename}`);
  });
});

describe('AC05 — cross-check: canonical migrations directory shape', () => {
  it('migrations/010_add_mount_target.sql sits next to prior migrations 001-009', () => {
    const migrationsDir = resolve(HERE, '..', 'migrations');
    const files = readdirSync(migrationsDir);
    for (const priorNum of ['001', '002', '005', '006', '007', '008', '009']) {
      const found = files.some((f) => f.startsWith(`${priorNum}_`));
      assert.ok(found, `expected a migrations/${priorNum}_*.sql file to exist as an ordering anchor`);
    }
  });
});
