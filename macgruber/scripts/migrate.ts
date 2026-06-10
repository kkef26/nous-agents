/**
 * Idempotent migration runner. Applies SQL files in lexical order from ../migrations/.
 * Tracks applied versions in nous._migrations_macgruber (created on first run).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '../src/db.js';
import { loadEnv } from '../src/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const TRACKING_DDL = `
CREATE TABLE IF NOT EXISTS nous._migrations_macgruber (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  sha256      text NOT NULL
);
`;

async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input).digest('hex');
}

async function main(): Promise<void> {
  loadEnv();
  const pool = getPool();
  await pool.query(TRACKING_DDL);

  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((n) => n.endsWith('.sql')).sort();

  const { rows: applied } = await pool.query<{ filename: string }>(
    'SELECT filename FROM nous._migrations_macgruber',
  );
  const appliedSet = new Set(applied.map((r) => r.filename));

  let appliedCount = 0;
  for (const filename of sqlFiles) {
    if (appliedSet.has(filename)) {
      process.stdout.write(`  ✓ ${filename} (already applied)\n`);
      continue;
    }
    const fullPath = join(MIGRATIONS_DIR, filename);
    const sql = await readFile(fullPath, 'utf8');
    const hash = await sha256(sql);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO nous._migrations_macgruber (filename, sha256) VALUES ($1, $2)',
        [filename, hash],
      );
      await client.query('COMMIT');
      process.stdout.write(`  + ${filename} applied\n`);
      appliedCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${filename} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  process.stdout.write(`migrate: ${appliedCount} new, ${sqlFiles.length - appliedCount} skipped\n`);
  await closePool();
}

main().catch((err: unknown) => {
  process.stderr.write(`migrate failed: ${(err as Error).message}\n`);
  process.exit(1);
});
