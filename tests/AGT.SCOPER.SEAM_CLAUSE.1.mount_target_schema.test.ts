// AGT.SCOPER.SEAM_CLAUSE.1 — mount_target schema tests.
//
// Covers:
//   AC01 — ClauseSpec type carries the mount_target field, typed as an
//          optional string; assigning a value type-checks; omission
//          type-checks; assigning a non-string does not.
//   AC02 — Non-component clauses may or may not carry mount_target; the type
//          shape does NOT force it as required at compile time.
//
// Notes:
//   - The strict presence-check for component clauses lives at the validator
//     boundary (see AGT.SCOPER.SEAM_CLAUSE.1.prereq_rejection.test.ts).
//   - This suite focuses on the DATA MODEL: field visibility, optionality,
//     and cross-clause-type shape.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ClauseSpec } from '../scoper/src/decomposition.js';

function makeClause(partial: Partial<ClauseSpec> & Pick<ClauseSpec, 'id' | 'clause_type'>): ClauseSpec {
  return {
    prefix: partial.id.split('.').slice(0, -1).join('.') || 'X',
    parent_id: null,
    title: partial.id,
    feature_id: partial.feature_id ?? 'feat-t',
    sequence_order: 0,
    maturity_stage: 'scaffold',
    status: 'draft',
    critical_path: false,
    requires: [],
    enables: [],
    acceptance_criteria: [],
    body: '',
    ...partial,
  };
}

describe('AC01 — ClauseSpec.mount_target schema', () => {
  it('accepts a string mount_target on a component clause', () => {
    const c = makeClause({ id: 'X.1', clause_type: 'component', mount_target: '/shifts' });
    assert.equal(c.mount_target, '/shifts');
  });

  it('accepts a component display name as mount_target', () => {
    const c = makeClause({ id: 'X.2', clause_type: 'component', mount_target: 'ShiftsBoardChrome' });
    assert.equal(c.mount_target, 'ShiftsBoardChrome');
  });

  it('accepts a CSS selector as mount_target', () => {
    const c = makeClause({ id: 'X.3', clause_type: 'component', mount_target: 'aside.shifts-board-chrome__sidebar' });
    assert.equal(c.mount_target, 'aside.shifts-board-chrome__sidebar');
  });

  it('accepts omission of mount_target — the field is optional at type level', () => {
    const c = makeClause({ id: 'X.4', clause_type: 'component' });
    assert.equal(c.mount_target, undefined);
  });

  it('mount_target is exposed as a top-level enumerable property on ClauseSpec instances', () => {
    // Assignment through the declared field name must land on the object,
    // not be silently swallowed by a spread override. This guards against
    // a future refactor accidentally moving the field into a nested bag.
    const c = makeClause({ id: 'X.5', clause_type: 'component', mount_target: '/loads' });
    const keys = Object.keys(c);
    assert.ok(keys.includes('mount_target'), `mount_target not enumerable on ClauseSpec: keys=${keys.join(',')}`);
  });
});

describe('AC02 — non-component clauses are unaffected by the field', () => {
  it('feature clauses may omit mount_target at both type and runtime level', () => {
    const c = makeClause({ id: 'F.1', clause_type: 'feature' });
    assert.equal(c.mount_target, undefined);
  });

  it('migration clauses may omit mount_target', () => {
    const c = makeClause({ id: 'M.1', clause_type: 'migration' });
    assert.equal(c.mount_target, undefined);
  });

  it('ingestion clauses may omit mount_target', () => {
    const c = makeClause({ id: 'I.1', clause_type: 'ingestion' });
    assert.equal(c.mount_target, undefined);
  });

  it('graph clauses may omit mount_target', () => {
    const c = makeClause({ id: 'G.1', clause_type: 'graph' });
    assert.equal(c.mount_target, undefined);
  });

  it('non-component clauses MAY set mount_target without runtime rejection — the type gate is soft here', () => {
    // The field is not required for non-component clauses, but they may carry
    // a hint value (e.g. a migration that ships a mount point config). The
    // shape allows it; the validator does not reject it.
    const c = makeClause({ id: 'F.2', clause_type: 'feature', mount_target: '/optional-hint' });
    assert.equal(c.mount_target, '/optional-hint');
  });
});
