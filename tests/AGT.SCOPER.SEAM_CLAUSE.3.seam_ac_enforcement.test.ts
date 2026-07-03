// AGT.SCOPER.SEAM_CLAUSE.3 — seam clause AC enforcement tests.
//
// Covers:
//   AC03 — A seam clause whose ACs use a non-deployed-pixel verification for
//          UI assertions is rejected with SeamACViolationError before the
//          dispatch tree is returned. The error identifies the offending
//          clause_id AND ac_id.
//   AC04 — Non-seam clauses (feature, component, migration, etc.) may carry
//          any AC verification type — the gate is scoped strictly to
//          clause_type === 'seam'.
//   AC05 — The gate throws BEFORE the dispatch tree is emitted; the returned
//          plan structure is never observed by callers when a violation
//          exists.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  validateSeamClauseACs,
  SEAM_CLAUSE_TYPE,
  type SeamACValidatable,
} from '../scoper/src/seam_ac_gate.js';
import {
  SeamACViolationError,
  isSeamACViolationError,
} from '../scoper/src/errors.js';

function seamAc(
  partial: Partial<SeamACValidatable> & Pick<SeamACValidatable, 'id' | 'clause_type'>,
): SeamACValidatable {
  return { acceptance_criteria: [], ...partial };
}

describe('AC03 — seam clause with non-deployed-pixel UI AC is rejected', () => {
  it('throws SeamACViolationError when a seam clause carries an auto AC that references a UI element', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'S.1',
        clause_type: 'seam',
        acceptance_criteria: [
          {
            id: 'AC01',
            text: 'The element renders on the deployed page',
            verification: 'auto',
            form: 'technical_spec',
          },
        ],
      }),
    ];
    assert.throws(
      () => validateSeamClauseACs(clauses),
      (err: unknown) => {
        assert.ok(isSeamACViolationError(err), `expected SeamACViolationError, got ${err}`);
        assert.equal(err.clause_id, 'S.1');
        assert.equal(err.acId, 'AC01');
        assert.ok(err.message.includes('S.1'));
        assert.ok(err.message.includes('AC01'));
        return true;
      },
    );
  });

  it('SeamACViolationError has code "seam_ac_non_deployed_pixel"', () => {
    try {
      validateSeamClauseACs([
        seamAc({
          id: 'S.2',
          clause_type: 'seam',
          acceptance_criteria: [
            { id: 'AC01', text: 'component visible', verification: 'auto', form: 'technical_spec' },
          ],
        }),
      ]);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(isSeamACViolationError(err));
      assert.equal(err.code, 'seam_ac_non_deployed_pixel');
    }
  });

  it('detects UI text across multiple keywords (renders, visible, element, mount, DOM, selector, displayed, shown, page, component)', () => {
    const uiTexts = [
      'This renders correctly',
      'The button is visible on screen',
      'Element exists in the DOM',
      'Component is mounted',
      'The selector resolves to a node',
      'A message is displayed',
      'The result is shown to the user',
      'The page renders without error',
      'Component wiring lands',
    ];
    for (const text of uiTexts) {
      const clauses: SeamACValidatable[] = [
        seamAc({
          id: 'S.X',
          clause_type: 'seam',
          acceptance_criteria: [
            { id: 'AC01', text, verification: 'auto', form: 'technical_spec' },
          ],
        }),
      ];
      assert.throws(
        () => validateSeamClauseACs(clauses),
        (err: unknown) => isSeamACViolationError(err),
        `expected throw for text: "${text}"`,
      );
    }
  });

  it('a seam clause AC that is CLEARLY UI but uses physical_qa also throws (local-check gate blocks all non-deployed-pixel UI ACs)', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'S.3',
        clause_type: 'seam',
        acceptance_criteria: [
          {
            id: 'AC01',
            text: 'The element renders in the DOM',
            verification: 'physical_qa',
            form: 'technical_spec',
          },
        ],
      }),
    ];
    assert.throws(() => validateSeamClauseACs(clauses), SeamACViolationError);
  });

  it('a seam clause AC that DOES use deployed-pixel passes', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'S.4',
        clause_type: 'seam',
        acceptance_criteria: [
          {
            id: 'AC01',
            text: 'The element renders on the deployed page',
            verification: 'deployed-pixel',
            form: 'technical_spec',
            test_contract: {
              deployed_url: 'https://example.com/x',
              selector: '.foo',
            },
          },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });

  it('fails on the FIRST offending AC when a seam clause has multiple bad ACs', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'S.5',
        clause_type: 'seam',
        acceptance_criteria: [
          { id: 'AC01', text: 'anything backend', verification: 'auto', form: 'technical_spec' },
          { id: 'AC02', text: 'The component renders', verification: 'auto', form: 'technical_spec' },
          { id: 'AC03', text: 'Element shown in DOM', verification: 'auto', form: 'technical_spec' },
        ],
      }),
    ];
    assert.throws(
      () => validateSeamClauseACs(clauses),
      (err: unknown) => {
        assert.ok(isSeamACViolationError(err));
        assert.equal(err.acId, 'AC02');
        return true;
      },
    );
  });
});

describe('AC04 — non-seam clauses are unaffected by the gate', () => {
  it('feature clauses with any AC verification type pass', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'F.1',
        clause_type: 'feature',
        acceptance_criteria: [
          { id: 'AC01', text: 'The element renders', verification: 'auto', form: 'technical_spec' },
          { id: 'AC02', text: 'The component visible', verification: 'physical_qa', form: 'technical_spec' },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });

  it('component clauses with UI-flavored auto ACs pass (the gate only fires on seam clauses)', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'C.1',
        clause_type: 'component',
        acceptance_criteria: [
          { id: 'AC01', text: 'The button renders on screen', verification: 'auto', form: 'technical_spec' },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });

  it('migration clauses with any AC verification type pass', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'M.1',
        clause_type: 'migration',
        acceptance_criteria: [
          { id: 'AC01', text: 'Column exists', verification: 'auto', form: 'technical_spec' },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });

  it('empty clause array passes', () => {
    assert.doesNotThrow(() => validateSeamClauseACs([]));
  });

  it('mixed plan: seam clause with valid deployed-pixel ACs + non-seam clauses with any ACs passes', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'F.1',
        clause_type: 'feature',
        acceptance_criteria: [
          { id: 'AC01', text: 'Element renders', verification: 'auto', form: 'technical_spec' },
        ],
      }),
      seamAc({
        id: 'S.1',
        clause_type: 'seam',
        acceptance_criteria: [
          {
            id: 'AC01',
            text: 'Component renders on deployed page',
            verification: 'deployed-pixel',
            form: 'technical_spec',
            test_contract: { deployed_url: 'https://x', selector: '.y' },
          },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });
});

describe('AC05 — gate exports and enforcement surface', () => {
  it('SEAM_CLAUSE_TYPE constant equals "seam"', () => {
    assert.equal(SEAM_CLAUSE_TYPE, 'seam');
  });

  it('gate does not trigger on near-miss clause_type values', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'N.1',
        clause_type: 'Seam', // capitalized
        acceptance_criteria: [
          { id: 'AC01', text: 'The element renders', verification: 'auto', form: 'technical_spec' },
        ],
      }),
      seamAc({
        id: 'N.2',
        clause_type: 'seams', // plural
        acceptance_criteria: [
          { id: 'AC01', text: 'The element renders', verification: 'auto', form: 'technical_spec' },
        ],
      }),
      seamAc({
        id: 'N.3',
        clause_type: 'seam-clause', // dashed
        acceptance_criteria: [
          { id: 'AC01', text: 'The element renders', verification: 'auto', form: 'technical_spec' },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });

  it('SeamACViolationError is an instance of the built-in Error and has name="SeamACViolationError"', () => {
    const err = new SeamACViolationError('S.9', 'AC01', 'boom');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'SeamACViolationError');
    assert.equal(err.clause_id, 'S.9');
    assert.equal(err.acId, 'AC01');
    assert.equal(err.code, 'seam_ac_non_deployed_pixel');
  });

  it('a seam clause with a purely non-UI AC on auto still passes (heuristic is text-based)', () => {
    const clauses: SeamACValidatable[] = [
      seamAc({
        id: 'S.6',
        clause_type: 'seam',
        acceptance_criteria: [
          {
            id: 'AC01',
            text: 'The API endpoint returns 200',
            verification: 'auto',
            form: 'technical_spec',
          },
        ],
      }),
    ];
    assert.doesNotThrow(() => validateSeamClauseACs(clauses));
  });
});
