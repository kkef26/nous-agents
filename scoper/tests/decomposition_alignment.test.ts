// NOUS.IDLOCK.5 — Feature-ID alignment guard tests.
//
// AXO.26 incident: an ID collision sent a foreign clause into the enrich batch
// and Scoper silently rewrote another feature's clause body. The guard MUST
// drop rows whose feature_id does not match the feature being planned and MUST
// emit a structured warning per skipped row.
//
// Tests target the pure helper applyAlignmentGuard() so they exercise the rule
// without standing up the full enrichment pipeline.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyAlignmentGuard, type BibleClauseRow } from '../src/decomposition.js';

function makeRow(id: string, feature_id: string | null): BibleClauseRow {
  return {
    id,
    prefix: id.split('.').slice(0, -1).join('.') || id,
    parent_id: null,
    feature_id,
    sequence_order: 1,
    maturity_stage: 'SCAFFOLD',
    status: 'draft',
    clause_type: 'feature',
    critical_path: false,
    requires: [],
    enables: [],
    acceptance_criteria: [],
    body: '',
    frontmatter: { title: id },
    contract: null,
  };
}

describe('applyAlignmentGuard', () => {
  it('keeps rows whose feature_id matches the planning feature', () => {
    const rows = [
      makeRow('NOUS.IDLOCK.5', 'NOUS.IDLOCK'),
      makeRow('NOUS.IDLOCK.6', 'NOUS.IDLOCK'),
    ];
    const { kept, skipped } = applyAlignmentGuard(rows, 'NOUS.IDLOCK');
    assert.equal(kept.length, 2);
    assert.equal(skipped.length, 0);
  });

  it('skips foreign-feature rows and records the skipped set with the foreign feature_id', () => {
    const rows = [
      makeRow('NOUS.IDLOCK.5', 'NOUS.IDLOCK'),
      makeRow('NOUS.IDLOCK.6', 'SOME.OTHER.FEATURE'),
      makeRow('NOUS.IDLOCK.7', 'NOUS.IDLOCK'),
    ];
    const { kept, skipped } = applyAlignmentGuard(rows, 'NOUS.IDLOCK');
    assert.deepEqual(kept.map((r) => r.id), ['NOUS.IDLOCK.5', 'NOUS.IDLOCK.7']);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].clause_id, 'NOUS.IDLOCK.6');
    assert.equal(skipped[0].row_feature_id, 'SOME.OTHER.FEATURE');
  });

  it('keeps rows whose feature_id is NULL (legacy un-claimed clauses)', () => {
    // NULL is a legitimate state for grandfathered rows pre-backfill (per
    // grill_decisions: "Backfill feature_id on 402 orphan clauses"). The guard
    // must not treat NULL as foreign.
    const rows = [makeRow('LEGACY.42', null)];
    const { kept, skipped } = applyAlignmentGuard(rows, 'NOUS.IDLOCK');
    assert.equal(kept.length, 1);
    assert.equal(skipped.length, 0);
  });

  it('skips every row when none match (no silent passthrough)', () => {
    const rows = [
      makeRow('FOREIGN.1', 'FEATURE.A'),
      makeRow('FOREIGN.2', 'FEATURE.B'),
    ];
    const { kept, skipped } = applyAlignmentGuard(rows, 'NOUS.IDLOCK');
    assert.equal(kept.length, 0);
    assert.equal(skipped.length, 2);
  });

  it('returns empty kept/skipped on empty input', () => {
    const { kept, skipped } = applyAlignmentGuard([], 'NOUS.IDLOCK');
    assert.equal(kept.length, 0);
    assert.equal(skipped.length, 0);
  });
});
