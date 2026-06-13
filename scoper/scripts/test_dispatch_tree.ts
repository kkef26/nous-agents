// NOUS.IDLOCK.6 — CLI script for AC verification.
//
// Usage:
//   node --experimental-strip-types scripts/test_dispatch_tree.ts --fixture <path>
//   tsx scripts/test_dispatch_tree.ts --fixture <path>
//
// Reads a JSON fixture {feature_group, clauses[]}, runs the same pipeline
// waves.ts uses (injectIngestionGates → organizeWaves), and prints:
//   - the gated clause array (so AC7 can grep requires[])
//   - the wave organization (so AC6 can confirm wave indexes)
// Exits 0 on success, non-zero on validation failure.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectIngestionGates } from '../src/ingestion_gate.js';
import { organizeWaves } from '../src/waves.js';
import type { ClauseSpec } from '../src/decomposition.js';

function parseArgs(argv: string[]): { fixture: string } {
  const idx = argv.indexOf('--fixture');
  if (idx === -1 || idx + 1 >= argv.length) {
    console.error('usage: test_dispatch_tree.ts --fixture <path>');
    process.exit(2);
  }
  return { fixture: argv[idx + 1] };
}

function loadFixture(path: string): { feature_group: string; clauses: ClauseSpec[] } {
  const abs = resolve(process.cwd(), path);
  const raw = readFileSync(abs, 'utf-8');
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object') throw new Error(`fixture ${path} is not an object`);
  if (typeof obj.feature_group !== 'string') throw new Error(`fixture ${path} missing feature_group`);
  if (!Array.isArray(obj.clauses)) throw new Error(`fixture ${path} missing clauses[]`);
  return obj as { feature_group: string; clauses: ClauseSpec[] };
}

function isIngestion(c: ClauseSpec): boolean { return (c.clause_type ?? '').toLowerCase() === 'ingestion'; }
function isGated(c: ClauseSpec): boolean {
  const t = (c.clause_type ?? '').toLowerCase();
  return t === 'graph' || t === 'read';
}

function main(): void {
  const { fixture } = parseArgs(process.argv.slice(2));
  const { feature_group, clauses } = loadFixture(fixture);

  const gated = injectIngestionGates(clauses);
  const organization = organizeWaves(feature_group, gated);

  // AC7 invariant: every graph/read clause must list at least one ingestion
  // clause in requires (provided ingestion clauses exist in the fixture).
  const ingestionIds = new Set(gated.filter(isIngestion).map((c) => c.id));
  const dependents = gated.filter(isGated);
  const violations: string[] = [];
  if (ingestionIds.size > 0) {
    for (const d of dependents) {
      const hit = d.requires.some((r) => ingestionIds.has(r));
      if (!hit) violations.push(`${d.id} (clause_type=${d.clause_type}) has no ingestion clause in requires[]`);
    }
  }

  // AC6 invariant: in the wave organization, every ingestion clause must
  // appear in a strictly earlier wave than every dependent clause from the
  // same feature.
  const waveIndexById = new Map<string, number>();
  for (const w of organization.waves) {
    for (const cid of w.clause_ids) waveIndexById.set(cid, w.index);
  }
  for (const ing of gated.filter(isIngestion)) {
    for (const dep of dependents) {
      if (ing.feature_id !== dep.feature_id) continue;
      const ingWave = waveIndexById.get(ing.id);
      const depWave = waveIndexById.get(dep.id);
      if (ingWave === undefined || depWave === undefined) continue;
      if (!(ingWave < depWave)) {
        violations.push(`wave order violated: ingestion ${ing.id} wave=${ingWave} should be < dependent ${dep.id} wave=${depWave}`);
      }
    }
  }

  const output = {
    fixture,
    feature_group: organization.feature_group,
    total_clauses: organization.total_clauses,
    waves: organization.waves.map((w) => ({ index: w.index, clause_ids: w.clause_ids })),
    gated_clauses: gated.map((c) => ({ id: c.id, clause_type: c.clause_type, feature_id: c.feature_id, requires: c.requires })),
    violations,
  };
  console.log(JSON.stringify(output, null, 2));

  if (violations.length > 0) {
    console.error(`\nFAILED: ${violations.length} invariant violation(s) detected.`);
    process.exit(1);
  }
}

main();
