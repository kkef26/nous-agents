// AGT.SCOPER.SEAM_CLAUSE.1 — prerequisite rejection tests.
//
// Covers:
//   AC03 — A plan containing a component clause without a declared
//          mount_target is rejected with a typed PrereqError that
//          identifies the offending clause_id and carries the machine-
//          readable code 'component_clause_missing_mount_target'.
//   AC04 — Non-component clauses missing mount_target do NOT trigger a
//          rejection. A plan of only non-component clauses (or a mixed plan
//          where every component clause is present with a mount_target)
//          validates cleanly.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  validateClauseMountTargets,
  findComponentClausesMissingMountTarget,
  COMPONENT_CLAUSE_TYPE,
  type MountTargetValidatable,
} from '../scoper/src/clause_validation.js';
import { PrereqError, isPrereqError } from '../scoper/src/errors.js';

function c(partial: Partial<MountTargetValidatable> & Pick<MountTargetValidatable, 'id' | 'clause_type'>): MountTargetValidatable {
  return { ...partial };
}

describe('AC03 — component clause missing mount_target is rejected', () => {
  it('throws PrereqError when a component clause has no mount_target field', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'X.1', clause_type: 'component' }),
    ];
    assert.throws(
      () => validateClauseMountTargets(clauses),
      (err: unknown) => {
        assert.ok(isPrereqError(err), `expected PrereqError, got ${err}`);
        assert.equal(err.code, 'component_clause_missing_mount_target');
        assert.equal(err.clause_id, 'X.1');
        assert.equal(err.detail.clause_type, 'component');
        assert.ok(err.message.includes('X.1'), `error message must identify the offending clause id, got: ${err.message}`);
        return true;
      },
    );
  });

  it('throws PrereqError when mount_target is an empty string', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'X.2', clause_type: 'component', mount_target: '' }),
    ];
    assert.throws(() => validateClauseMountTargets(clauses), PrereqError);
  });

  it('throws PrereqError when mount_target is whitespace only', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'X.3', clause_type: 'component', mount_target: '   \t\n' }),
    ];
    assert.throws(() => validateClauseMountTargets(clauses), PrereqError);
  });

  it('fails on the FIRST offending component clause when multiple are missing', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'X.1', clause_type: 'feature' }),
      c({ id: 'X.2', clause_type: 'component' }),
      c({ id: 'X.3', clause_type: 'component' }),
    ];
    assert.throws(
      () => validateClauseMountTargets(clauses),
      (err: unknown) => {
        assert.ok(isPrereqError(err));
        // First component clause in iteration order (X.2) is the reported one.
        assert.equal(err.clause_id, 'X.2');
        return true;
      },
    );
  });

  it('non-throwing variant lists every offender in one pass', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'X.1', clause_type: 'feature' }),
      c({ id: 'X.2', clause_type: 'component' }),
      c({ id: 'X.3', clause_type: 'component', mount_target: '/ok' }),
      c({ id: 'X.4', clause_type: 'component' }),
    ];
    const offenders = findComponentClausesMissingMountTarget(clauses);
    assert.deepEqual(offenders, ['X.2', 'X.4']);
  });

  it('PrereqError is an instance of the built-in Error and has name="PrereqError"', () => {
    const err = new PrereqError('component_clause_missing_mount_target', 'boom', { clause_id: 'X.9' });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'PrereqError');
    assert.equal(err.clause_id, 'X.9');
  });
});

describe('AC04 — non-component clauses are unaffected by the gate', () => {
  it('feature clauses without mount_target pass validation', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'F.1', clause_type: 'feature' }),
      c({ id: 'F.2', clause_type: 'feature' }),
    ];
    assert.doesNotThrow(() => validateClauseMountTargets(clauses));
  });

  it('mixed plan with every component clause carrying mount_target passes', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'F.1', clause_type: 'feature' }),
      c({ id: 'C.1', clause_type: 'component', mount_target: '/shifts' }),
      c({ id: 'M.1', clause_type: 'migration' }),
      c({ id: 'C.2', clause_type: 'component', mount_target: 'ShiftsBoardChrome' }),
      c({ id: 'I.1', clause_type: 'ingestion' }),
    ];
    assert.doesNotThrow(() => validateClauseMountTargets(clauses));
  });

  it('empty clause array passes without error', () => {
    assert.doesNotThrow(() => validateClauseMountTargets([]));
  });

  it('a plan with zero component clauses passes even if every other type is present', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'F.1', clause_type: 'feature' }),
      c({ id: 'M.1', clause_type: 'migration' }),
      c({ id: 'I.1', clause_type: 'ingestion' }),
      c({ id: 'G.1', clause_type: 'graph' }),
      c({ id: 'S.1', clause_type: 'seam' }),
    ];
    assert.doesNotThrow(() => validateClauseMountTargets(clauses));
  });

  it('non-throwing variant returns an empty list for a clean plan', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'F.1', clause_type: 'feature' }),
      c({ id: 'C.1', clause_type: 'component', mount_target: '/x' }),
    ];
    assert.deepEqual(findComponentClausesMissingMountTarget(clauses), []);
  });
});

describe('AC03 + AC04 — invariant: COMPONENT_CLAUSE_TYPE constant is the ONLY string that triggers the gate', () => {
  it('exports the constant string "component"', () => {
    assert.equal(COMPONENT_CLAUSE_TYPE, 'component');
  });

  it('gate does not trigger on near-miss clause_type values', () => {
    const clauses: MountTargetValidatable[] = [
      c({ id: 'N.1', clause_type: 'Component' }),  // capitalized
      c({ id: 'N.2', clause_type: 'components' }), // plural
      c({ id: 'N.3', clause_type: 'ui-component' }), // dashed
      c({ id: 'N.4', clause_type: 'compnent' }),   // typo
    ];
    assert.doesNotThrow(() => validateClauseMountTargets(clauses));
  });
});
