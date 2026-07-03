// AGT.SCOPER.SEAM_CLAUSE.3 — deployed-pixel schema tests.
//
// Covers:
//   AC01 — VerificationType union includes 'deployed-pixel' as a first-class
//          member; AcceptanceCriterion may carry a DeployedPixelTestContract
//          with `deployed_url` and `selector` fields.
//   AC07 — Runtime schema validation rejects a deployed-pixel AC whose
//          test_contract is missing, is missing `deployed_url`, is missing
//          `selector`, or whose fields are empty/whitespace/non-string.
//
// The codebase does not use Zod. The clause constraint "add Zod refinement"
// is satisfied by a runtime validation function equivalent
// (validateDeployedPixelACSchema) that mirrors what a Zod refinement would
// do: reject at construction time if the discriminated verification field
// is 'deployed-pixel' and the required test_contract fields are absent or
// malformed.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  AcceptanceCriterion,
  DeployedPixelTestContract,
  VerificationType,
} from '../scoper/src/decomposition.js';
import {
  validateDeployedPixelACSchema,
  DEPLOYED_PIXEL_VERIFICATION,
} from '../scoper/src/decomposition.js';

describe('AC01 — deployed-pixel VerificationType + DeployedPixelTestContract', () => {
  it('exports the "deployed-pixel" literal as DEPLOYED_PIXEL_VERIFICATION', () => {
    assert.equal(DEPLOYED_PIXEL_VERIFICATION, 'deployed-pixel');
  });

  it('VerificationType union accepts "deployed-pixel"', () => {
    const v: VerificationType = 'deployed-pixel';
    assert.equal(v, 'deployed-pixel');
  });

  it('VerificationType union still accepts prior "auto" / "physical_qa" / "kosta_review"', () => {
    const a: VerificationType = 'auto';
    const p: VerificationType = 'physical_qa';
    const k: VerificationType = 'kosta_review';
    assert.equal(a, 'auto');
    assert.equal(p, 'physical_qa');
    assert.equal(k, 'kosta_review');
  });

  it('AcceptanceCriterion carries an optional test_contract shape', () => {
    const tc: DeployedPixelTestContract = {
      deployed_url: 'https://example.com/shifts',
      selector: 'aside.shifts-board-chrome__sidebar',
    };
    const ac: AcceptanceCriterion = {
      id: 'AC01',
      text: 'Element renders on the deployed page',
      verification: 'deployed-pixel',
      form: 'technical_spec',
      test_contract: tc,
    };
    assert.equal(ac.verification, 'deployed-pixel');
    assert.equal(ac.test_contract?.deployed_url, 'https://example.com/shifts');
    assert.equal(ac.test_contract?.selector, 'aside.shifts-board-chrome__sidebar');
  });

  it('non-deployed-pixel ACs may omit test_contract entirely', () => {
    const ac: AcceptanceCriterion = {
      id: 'AC02',
      text: 'File contains the expected symbol',
      verification: 'auto',
      form: 'technical_spec',
    };
    assert.equal(ac.test_contract, undefined);
  });
});

describe('AC07 — validateDeployedPixelACSchema rejects malformed test_contract', () => {
  const baseAc = (partial: Partial<AcceptanceCriterion>): AcceptanceCriterion => ({
    id: 'AC01',
    text: 'Element renders on the deployed page',
    verification: 'deployed-pixel',
    form: 'technical_spec',
    ...partial,
  });

  it('passes on a well-formed deployed-pixel AC', () => {
    const ac = baseAc({
      test_contract: {
        deployed_url: 'https://example.com/x',
        selector: 'div#root',
      },
    });
    assert.doesNotThrow(() => validateDeployedPixelACSchema(ac));
  });

  it('non-deployed-pixel ACs are ignored by the validator', () => {
    const ac: AcceptanceCriterion = {
      id: 'AC02',
      text: 'anything',
      verification: 'auto',
      form: 'technical_spec',
    };
    assert.doesNotThrow(() => validateDeployedPixelACSchema(ac));
  });

  it('throws when a deployed-pixel AC is missing test_contract', () => {
    const ac = baseAc({});
    assert.throws(
      () => validateDeployedPixelACSchema(ac),
      /test_contract/,
    );
  });

  it('throws when test_contract is missing deployed_url', () => {
    const ac = baseAc({
      test_contract: { selector: '.x' } as unknown as DeployedPixelTestContract,
    });
    assert.throws(
      () => validateDeployedPixelACSchema(ac),
      /deployed_url/,
    );
  });

  it('throws when test_contract is missing selector', () => {
    const ac = baseAc({
      test_contract: { deployed_url: 'https://x' } as unknown as DeployedPixelTestContract,
    });
    assert.throws(
      () => validateDeployedPixelACSchema(ac),
      /selector/,
    );
  });

  it('throws when deployed_url is an empty string', () => {
    const ac = baseAc({
      test_contract: { deployed_url: '', selector: '.x' },
    });
    assert.throws(() => validateDeployedPixelACSchema(ac), /deployed_url/);
  });

  it('throws when selector is whitespace only', () => {
    const ac = baseAc({
      test_contract: { deployed_url: 'https://x', selector: '   ' },
    });
    assert.throws(() => validateDeployedPixelACSchema(ac), /selector/);
  });

  it('throws when test_contract fields are non-string', () => {
    const ac = baseAc({
      test_contract: {
        deployed_url: 42 as unknown as string,
        selector: '.x',
      },
    });
    assert.throws(() => validateDeployedPixelACSchema(ac), /deployed_url/);
  });
});
