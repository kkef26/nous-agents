// NOUS.IDLOCK.6 — Unit tests for injectIngestionGates.
//
// Covers the 7 acceptance criteria in NOUS.IDLOCK.6:
//   AC1 — graph clauses gain all sibling ingestion IDs in requires[]
//   AC2 — graph-only batch is unchanged
//   AC3 — duplicate ingestion IDs in requires[] are not re-added
//   AC4 — cross-feature isolation (feature A ingestion does NOT leak into
//         feature B graph)
//   AC5 — modified clauses are NEW object references
//   AC6 — verified in scripts/test_dispatch_tree.ts + waves.ts wiring
//   AC7 — verified in scripts/test_dispatch_tree.ts CLI

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { injectIngestionGates } from '../src/ingestion_gate.js';
import type { ClauseSpec } from '../src/decomposition.js';

function clause(partial: Partial<ClauseSpec> & Pick<ClauseSpec, 'id' | 'clause_type' | 'feature_id'>): ClauseSpec {
  return {
    prefix: partial.id.split('.').slice(0, -1).join('.'),
    parent_id: null,
    title: partial.id,
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

describe('injectIngestionGates — AC1: graph clauses gain ingestion requires', () => {
  it('injects every sibling ingestion ID into each graph clause requires[]', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.2', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a' }),
      clause({ id: 'F.9', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    const g5 = out.find((c) => c.id === 'F.5')!;
    const g9 = out.find((c) => c.id === 'F.9')!;
    assert.deepEqual([...g5.requires].sort(), ['F.1', 'F.2']);
    assert.deepEqual([...g9.requires].sort(), ['F.1', 'F.2']);
  });

  it('treats read clauses the same as graph clauses', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.10', clause_type: 'read', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    const r10 = out.find((c) => c.id === 'F.10')!;
    assert.deepEqual(r10.requires, ['F.1']);
  });
});

describe('injectIngestionGates — AC2: no-op when ingestion absent', () => {
  it('returns the array unchanged when there are zero ingestion clauses', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'G.1', clause_type: 'graph', feature_id: 'feat-a', requires: ['EXT.1'] }),
      clause({ id: 'G.2', clause_type: 'graph', feature_id: 'feat-a' }),
      clause({ id: 'R.3', clause_type: 'read', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    assert.equal(out.length, input.length);
    for (let i = 0; i < input.length; i += 1) {
      assert.strictEqual(out[i], input[i], `clause ${input[i].id} should be unchanged ref`);
      assert.deepEqual(out[i].requires, input[i].requires);
    }
  });

  it('returns a fresh array (not the input reference) even on no-op', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'G.1', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    assert.notStrictEqual(out, input);
  });
});

describe('injectIngestionGates — AC3: dedup', () => {
  it('does not add a duplicate ingestion ID when already in requires[]', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.2', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a', requires: ['F.1'] }),
    ];
    const out = injectIngestionGates(input);
    const g5 = out.find((c) => c.id === 'F.5')!;
    const count = g5.requires.filter((r) => r === 'F.1').length;
    assert.equal(count, 1, 'F.1 must appear exactly once');
    assert.deepEqual([...g5.requires].sort(), ['F.1', 'F.2']);
  });

  it('idempotent: running twice yields the same requires[] set', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const once = injectIngestionGates(input);
    const twice = injectIngestionGates(once);
    const g5Once = once.find((c) => c.id === 'F.5')!;
    const g5Twice = twice.find((c) => c.id === 'F.5')!;
    assert.deepEqual([...g5Twice.requires].sort(), [...g5Once.requires].sort());
  });
});

describe('injectIngestionGates — AC4: cross-feature isolation', () => {
  it('does not inject feature-A ingestion IDs into feature-B graph clauses', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'A.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'A.5', clause_type: 'graph', feature_id: 'feat-a' }),
      clause({ id: 'B.1', clause_type: 'ingestion', feature_id: 'feat-b' }),
      clause({ id: 'B.5', clause_type: 'graph', feature_id: 'feat-b' }),
    ];
    const out = injectIngestionGates(input);
    const aGraph = out.find((c) => c.id === 'A.5')!;
    const bGraph = out.find((c) => c.id === 'B.5')!;
    assert.deepEqual(aGraph.requires, ['A.1']);
    assert.deepEqual(bGraph.requires, ['B.1']);
    assert.equal(aGraph.requires.includes('B.1'), false);
    assert.equal(bGraph.requires.includes('A.1'), false);
  });

  it('leaves graph clauses in features with no ingestion clauses unchanged', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'A.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'A.5', clause_type: 'graph', feature_id: 'feat-a' }),
      clause({ id: 'B.5', clause_type: 'graph', feature_id: 'feat-b', requires: ['EXT.1'] }),
    ];
    const out = injectIngestionGates(input);
    const bGraph = out.find((c) => c.id === 'B.5')!;
    assert.deepEqual(bGraph.requires, ['EXT.1']);
    const inputB = input.find((c) => c.id === 'B.5')!;
    assert.strictEqual(bGraph, inputB, 'untouched clause should be original ref');
  });
});

describe('injectIngestionGates — AC5: no mutation', () => {
  it('returns new object refs for every modified clause', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const inputRequiresRef = input[1].requires;
    const out = injectIngestionGates(input);
    const g5 = out.find((c) => c.id === 'F.5')!;
    const f5In = input.find((c) => c.id === 'F.5')!;
    assert.notStrictEqual(g5, f5In, 'modified clause must be a new object');
    assert.notStrictEqual(g5.requires, inputRequiresRef, 'requires array must be new');
    assert.deepEqual(f5In.requires, [], 'original requires[] must remain empty');
  });

  it('does not mutate the input array', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const before = JSON.stringify(input);
    injectIngestionGates(input);
    const after = JSON.stringify(input);
    assert.equal(before, after);
  });
});

describe('injectIngestionGates — edge cases', () => {
  it('handles empty input', () => {
    const out = injectIngestionGates([]);
    assert.deepEqual(out, []);
  });

  it('leaves non-ingestion/non-graph clause types untouched', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: 'feat-a' }),
      clause({ id: 'F.2', clause_type: 'migration', feature_id: 'feat-a' }),
      clause({ id: 'F.3', clause_type: 'infrastructure', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    const f2 = out.find((c) => c.id === 'F.2')!;
    const f3 = out.find((c) => c.id === 'F.3')!;
    assert.strictEqual(f2, input[1]);
    assert.strictEqual(f3, input[2]);
  });

  it('ignores ingestion clauses without a feature_id', () => {
    const input: ClauseSpec[] = [
      clause({ id: 'F.1', clause_type: 'ingestion', feature_id: '' }),
      clause({ id: 'F.5', clause_type: 'graph', feature_id: 'feat-a' }),
    ];
    const out = injectIngestionGates(input);
    const g5 = out.find((c) => c.id === 'F.5')!;
    assert.deepEqual(g5.requires, []);
  });
});
