// AGT.SCOPER.SEAM_CLAUSE.2 — seam-clause injection tests.
//
// Covers AC01–AC06 for automatic seam clause synthesis at the end of the
// decomposition step. Tests use in-memory plan fixtures — no DB, no LLM.
//
//   AC01 — Given a plan with N ≥ 1 component clauses, injectSeamClause returns
//          a plan with N+1 clauses including exactly one seam clause. The seam
//          clause requires[] contains every component clause id and its
//          wiring_manifest contains every distinct mount_target.
//   AC02 — Plans with 0 component clauses are unaffected — no seam is appended.
//   AC03 — After organizeWaves, the seam clause lands in the final wave; its
//          sequence_order exceeds every other clause in the plan.
//   AC04 — wiring_manifest deduplicates duplicate mount_target strings and
//          preserves first-seen order.
//   AC05 — injectSeamClause does not mutate the input plan (arrays, clauses,
//          or nested requires arrays).
//   AC06 — The synthesized seam clause's contract.exclusions + antipatterns
//          assert the shared-mount-point antipattern that non-seam clauses
//          must not touch shared mount points.
//
// Plus two structural invariants pulled from the clause constraints:
//   - injectSeamClause is IDEMPOTENT (never injects a second seam).
//   - buildSeamClause refuses zero-component inputs (there is nothing to wire).

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { organizeWaves } from '../scoper/src/waves.js';
import {
  buildSeamClause,
  injectSeamClause,
  SEAM_CLAUSE_TYPE,
  type SeamClause,
} from '../scoper/src/seam.js';
import type { ClauseSpec } from '../scoper/src/decomposition.js';

function makeClause(
  partial: Partial<ClauseSpec> & Pick<ClauseSpec, 'id' | 'clause_type'>,
): ClauseSpec {
  return {
    prefix: partial.id.split('.').slice(0, -1).join('.') || 'X',
    parent_id: null,
    title: partial.id,
    feature_id: 'feat-t',
    sequence_order: 0,
    maturity_stage: 'SCAFFOLD',
    status: 'draft',
    critical_path: false,
    requires: [],
    enables: [],
    acceptance_criteria: [],
    body: '',
    ...partial,
  };
}

describe('AC01 — seam clause is injected when component clauses exist', () => {
  it('appends exactly one seam clause given N ≥ 1 component clauses', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/shifts' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: 'ShiftsBoardChrome' }),
    ];
    const out = injectSeamClause(input);
    assert.equal(out.length, input.length + 1);
    const seams = out.filter((c) => c.clause_type === SEAM_CLAUSE_TYPE);
    assert.equal(seams.length, 1);
  });

  it('seam clause requires[] lists every component clause id in encounter order', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      makeClause({ id: 'X.2', clause_type: 'feature' }),
      makeClause({ id: 'X.3', clause_type: 'component', mount_target: '/b' }),
    ];
    const out = injectSeamClause(input);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.deepEqual(seam.requires, ['X.1', 'X.3']);
  });

  it('seam.wiring_manifest contains every distinct mount_target', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/shifts' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: 'ShiftsBoardChrome' }),
    ];
    const out = injectSeamClause(input);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.deepEqual(seam.wiring_manifest, ['/shifts', 'ShiftsBoardChrome']);
  });

  it('seam clause carries clause_type === "seam"', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/x' }),
    ];
    const out = injectSeamClause(input);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.equal(seam.clause_type, SEAM_CLAUSE_TYPE);
    assert.equal(seam.clause_type, 'seam');
  });

  it('seam clause carries wiring_manifest as an enumerable string[] property', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/x' }),
    ];
    const out = injectSeamClause(input);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.ok(Array.isArray(seam.wiring_manifest));
    assert.ok(Object.keys(seam).includes('wiring_manifest'));
  });

  it('seam clause inherits feature_id from the first component clause', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/x', feature_id: 'feat-alpha' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '/y', feature_id: 'feat-alpha' }),
    ];
    const out = injectSeamClause(input);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.equal(seam.feature_id, 'feat-alpha');
  });
});

describe('AC02 — plans with 0 component clauses are unaffected', () => {
  it('returns clauses with no seam appended when only feature clauses are present', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'F.1', clause_type: 'feature' }),
      makeClause({ id: 'F.2', clause_type: 'feature' }),
    ];
    const out = injectSeamClause(input);
    assert.equal(out.length, input.length);
    assert.equal(out.filter((c) => c.clause_type === SEAM_CLAUSE_TYPE).length, 0);
  });

  it('empty input array yields empty output with no seam', () => {
    const out = injectSeamClause([]);
    assert.equal(out.length, 0);
  });

  it('mixed non-component plan yields no seam', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'F.1', clause_type: 'feature' }),
      makeClause({ id: 'M.1', clause_type: 'migration' }),
      makeClause({ id: 'I.1', clause_type: 'ingestion' }),
      makeClause({ id: 'G.1', clause_type: 'graph' }),
    ];
    const out = injectSeamClause(input);
    assert.equal(out.filter((c) => c.clause_type === SEAM_CLAUSE_TYPE).length, 0);
    assert.equal(out.length, input.length);
  });
});

describe('AC03 — seam clause lands in the final wave after organizeWaves', () => {
  it('seam.sequence_order is the strict maximum across all clauses', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '/b' }),
      makeClause({ id: 'X.3', clause_type: 'feature' }),
    ];
    const withSeam = injectSeamClause(input);
    const org = organizeWaves('feat-t', withSeam);
    const seam = org.clauses.find((c) => c.clause_type === SEAM_CLAUSE_TYPE);
    assert.ok(seam, 'seam clause must survive wave organization');
    const otherSeqs = org.clauses
      .filter((c) => c.clause_type !== SEAM_CLAUSE_TYPE)
      .map((c) => c.sequence_order);
    const maxOther = otherSeqs.length > 0 ? Math.max(...otherSeqs) : 0;
    assert.ok(
      seam.sequence_order > maxOther,
      `seam seq=${seam.sequence_order} must exceed max non-seam seq=${maxOther}`,
    );
  });

  it('seam is the sole occupant of the final wave when all other clauses layer earlier', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '/b' }),
    ];
    const withSeam = injectSeamClause(input);
    const org = organizeWaves('feat-t', withSeam);
    assert.ok(org.waves.length >= 2, 'expected at least 2 waves given the seam requires component clauses');
    const lastWave = org.waves[org.waves.length - 1];
    const seam = org.clauses.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.ok(lastWave.clause_ids.includes(seam.id));
    assert.equal(lastWave.clause_ids.length, 1, 'seam clause must be the sole occupant of the final wave');
  });

  it('no other wave contains the seam clause', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
    ];
    const withSeam = injectSeamClause(input);
    const org = organizeWaves('feat-t', withSeam);
    const seam = org.clauses.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    const seamAppearances = org.waves.filter((w) => w.clause_ids.includes(seam.id));
    assert.equal(seamAppearances.length, 1);
    const lastIndex = org.waves.length - 1;
    assert.equal(seamAppearances[0].index, lastIndex);
  });
});

describe('AC04 — wiring_manifest deduplicates mount_target strings', () => {
  it('duplicate mount_target strings collapse to a single manifest entry', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/shifts' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '/shifts' }),
      makeClause({ id: 'X.3', clause_type: 'component', mount_target: '/loads' }),
    ];
    const seam = buildSeamClause(input);
    assert.deepEqual(seam.wiring_manifest, ['/shifts', '/loads']);
  });

  it('preserves first-seen order for distinct mount_targets', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: 'B' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: 'A' }),
      makeClause({ id: 'X.3', clause_type: 'component', mount_target: 'C' }),
    ];
    const seam = buildSeamClause(input);
    assert.deepEqual(seam.wiring_manifest, ['B', 'A', 'C']);
  });

  it('ignores empty and whitespace-only mount_target values and omitted fields', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '' }),
      makeClause({ id: 'X.3', clause_type: 'component', mount_target: '   \t' }),
      makeClause({ id: 'X.4', clause_type: 'component' }),
    ];
    const seam = buildSeamClause(input);
    assert.deepEqual(seam.wiring_manifest, ['/a']);
  });

  it('contract.elements mirrors wiring_manifest one-to-one with kind="mount_point"', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/shifts' }),
      makeClause({ id: 'X.2', clause_type: 'component', mount_target: '/loads' }),
    ];
    const seam = buildSeamClause(input);
    assert.ok(seam.contract);
    const elements = seam.contract!.elements;
    assert.equal(elements.length, seam.wiring_manifest.length);
    for (const [i, mt] of seam.wiring_manifest.entries()) {
      const el = elements[i];
      assert.ok(typeof el === 'object' && el !== null);
      assert.equal((el as { kind: string }).kind, 'mount_point');
      assert.equal((el as { name: string }).name, mt);
    }
  });
});

describe('AC05 — injectSeamClause does not mutate the input plan', () => {
  it('does not mutate the input array length or clause contents', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      makeClause({ id: 'X.2', clause_type: 'feature' }),
    ];
    const snapshot = input.map((c) => ({ ...c }));
    const before_length = input.length;
    injectSeamClause(input);
    assert.equal(input.length, before_length);
    for (let i = 0; i < input.length; i++) {
      assert.deepEqual(input[i], snapshot[i]);
    }
  });

  it('returns a NEW array reference, not the input reference', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
    ];
    const out = injectSeamClause(input);
    assert.notStrictEqual(out, input);
  });

  it('does not mutate the individual clause objects passed in (requires reference stability)', () => {
    const c1 = makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' });
    const originalRequires = c1.requires;
    const originalEnables = c1.enables;
    injectSeamClause([c1]);
    assert.strictEqual(c1.requires, originalRequires);
    assert.strictEqual(c1.enables, originalEnables);
  });

  it('does not mutate the input when there are no component clauses', () => {
    const input: ClauseSpec[] = [makeClause({ id: 'F.1', clause_type: 'feature' })];
    const snapshot = input.map((c) => ({ ...c }));
    const out = injectSeamClause(input);
    assert.equal(input.length, snapshot.length);
    assert.deepEqual(input[0], snapshot[0]);
    assert.notStrictEqual(out, input);
  });
});

describe('AC06 — seam clause asserts the shared-mount-point antipattern', () => {
  it('contract.exclusions carries an entry naming the shared-mount-point antipattern', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
    ];
    const seam = buildSeamClause(input);
    assert.ok(seam.contract, 'seam contract must exist');
    const excl = seam.contract!.exclusions;
    assert.ok(excl.length > 0, 'contract.exclusions must be non-empty');
    const hasAntipatternMatch = excl.some((e) => {
      if (typeof e === 'string') return /shared mount|mount point/i.test(e);
      return /shared|mount/i.test(String(e.name)) || /shared|mount/i.test(String(e.prior ?? ''));
    });
    assert.ok(hasAntipatternMatch, 'contract.exclusions must reference the shared mount-point antipattern');
  });

  it('contract.antipatterns records the do-not statement targeting non-seam clauses', () => {
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
    ];
    const seam = buildSeamClause(input);
    assert.ok(seam.contract);
    const antipatterns = seam.contract!.antipatterns;
    assert.ok(antipatterns.length > 0);
    const hasDoNot = antipatterns.some((ap) => {
      const t = typeof ap === 'string' ? ap : ap.text;
      return /do not/i.test(t) && /mount/i.test(t);
    });
    assert.ok(hasDoNot, 'antipatterns must include a Do-NOT statement referencing mount points');
  });
});

describe('injectSeamClause structural invariants', () => {
  it('is idempotent — never injects a second seam when one already exists', () => {
    const preexistingSeam = makeClause({ id: 'X.SEAM', clause_type: SEAM_CLAUSE_TYPE });
    const input: ClauseSpec[] = [
      makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/a' }),
      preexistingSeam,
    ];
    const out = injectSeamClause(input);
    const seams = out.filter((c) => c.clause_type === SEAM_CLAUSE_TYPE);
    assert.equal(seams.length, 1);
    // The preserved seam is the input's seam, not a new synthesized one.
    assert.strictEqual(seams[0], preexistingSeam);
  });

  it('injects at most one seam even when many component clauses share the same mount_target', () => {
    const input: ClauseSpec[] = Array.from({ length: 5 }, (_, i) =>
      makeClause({ id: `X.${i + 1}`, clause_type: 'component', mount_target: '/dupe' }),
    );
    const out = injectSeamClause(input);
    assert.equal(out.filter((c) => c.clause_type === SEAM_CLAUSE_TYPE).length, 1);
    const seam = out.find((c) => c.clause_type === SEAM_CLAUSE_TYPE) as SeamClause;
    assert.deepEqual(seam.wiring_manifest, ['/dupe']);
    assert.deepEqual(seam.requires, ['X.1', 'X.2', 'X.3', 'X.4', 'X.5']);
  });
});

describe('buildSeamClause defensive contract', () => {
  it('throws when called with zero clauses (nothing to wire)', () => {
    assert.throws(() => buildSeamClause([]), /at least one/i);
  });
});
