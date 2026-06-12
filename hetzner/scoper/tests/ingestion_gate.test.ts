// NOUS.IDLOCK.6 — Tests for injectIngestionGates.
//
// The gate makes every graph/read clause hard-require every ingestion clause
// in the same feature batch. Tests cover:
//   - ingestion present → graph/read clauses gain the ingestion ids as requires
//   - ingestion absent → no-op pass-through
//   - duplicate-requires deduplication on idempotent re-invocation
//   - input is NOT mutated in place (new objects, new requires arrays)
//   - non-graph/read clause types pass through unchanged
//   - rewritten_ids telemetry reflects clauses actually changed

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { injectIngestionGates, type GatedClause } from '../src/gates/ingestion_gate.js';

function clause(id: string, clause_type: string, requires: string[] = []): GatedClause {
  return { id, clause_type, requires };
}

describe('injectIngestionGates — ingestion present', () => {
  it('adds every ingestion id to every graph and read clause requires', () => {
    const input = [
      clause('F.1', 'ingestion'),
      clause('F.2', 'ingestion'),
      clause('F.3', 'graph'),
      clause('F.4', 'read'),
    ];
    const { clauses, ingestion_ids, rewritten_ids } = injectIngestionGates(input);

    assert.deepEqual(ingestion_ids.sort(), ['F.1', 'F.2']);
    assert.deepEqual(rewritten_ids.sort(), ['F.3', 'F.4']);

    const byId = new Map(clauses.map((c) => [c.id, c]));
    assert.deepEqual(byId.get('F.3')!.requires.sort(), ['F.1', 'F.2']);
    assert.deepEqual(byId.get('F.4')!.requires.sort(), ['F.1', 'F.2']);
    // Ingestion clauses themselves are not gated.
    assert.deepEqual(byId.get('F.1')!.requires, []);
    assert.deepEqual(byId.get('F.2')!.requires, []);
  });

  it('preserves pre-existing requires and merges (no overwrite)', () => {
    const input = [
      clause('F.1', 'ingestion'),
      clause('F.3', 'graph', ['EXTERNAL.A', 'EXTERNAL.B']),
    ];
    const { clauses } = injectIngestionGates(input);
    const f3 = clauses.find((c) => c.id === 'F.3')!;
    assert.deepEqual(f3.requires.sort(), ['EXTERNAL.A', 'EXTERNAL.B', 'F.1']);
  });
});

describe('injectIngestionGates — ingestion absent', () => {
  it('is a no-op when no ingestion clause is in the batch', () => {
    const input = [
      clause('F.3', 'graph'),
      clause('F.4', 'read', ['F.3']),
      clause('F.5', 'feature'),
    ];
    const { clauses, ingestion_ids, rewritten_ids } = injectIngestionGates(input);

    assert.equal(ingestion_ids.length, 0);
    assert.equal(rewritten_ids.length, 0);
    assert.equal(clauses.length, 3);
    const f4 = clauses.find((c) => c.id === 'F.4')!;
    assert.deepEqual(f4.requires, ['F.3']);
  });
});

describe('injectIngestionGates — deduplication + idempotency', () => {
  it('does not add duplicate entries when ingestion id is already in requires', () => {
    const input = [
      clause('F.1', 'ingestion'),
      clause('F.3', 'graph', ['F.1']),
    ];
    const { clauses, rewritten_ids } = injectIngestionGates(input);
    const f3 = clauses.find((c) => c.id === 'F.3')!;
    assert.deepEqual(f3.requires, ['F.1']);
    // Already covered — not counted as rewritten.
    assert.equal(rewritten_ids.length, 0);
  });

  it('is idempotent: gate(gate(input)) == gate(input)', () => {
    const input = [
      clause('F.1', 'ingestion'),
      clause('F.2', 'ingestion'),
      clause('F.3', 'graph'),
      clause('F.4', 'read'),
    ];
    const once = injectIngestionGates(input);
    const twice = injectIngestionGates(once.clauses);
    const sortReqs = (cs: GatedClause[]) => cs
      .map((c) => ({ id: c.id, type: c.clause_type, req: [...c.requires].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sortReqs(twice.clauses), sortReqs(once.clauses));
  });
});

describe('injectIngestionGates — no in-place mutation', () => {
  it('returns new objects with new requires arrays — input is untouched', () => {
    const f3Requires: string[] = [];
    const input = [
      clause('F.1', 'ingestion'),
      { id: 'F.3', clause_type: 'graph', requires: f3Requires },
    ];
    const { clauses } = injectIngestionGates(input);

    // Input objects and arrays must be untouched.
    assert.equal(input[1].requires, f3Requires);
    assert.equal(f3Requires.length, 0);

    // Returned object must be a fresh reference with a fresh requires array.
    const f3Out = clauses.find((c) => c.id === 'F.3')!;
    assert.notEqual(f3Out, input[1]);
    assert.notEqual(f3Out.requires, f3Requires);
    assert.deepEqual(f3Out.requires, ['F.1']);
  });
});

describe('injectIngestionGates — other types pass through', () => {
  it('does not modify feature/infrastructure/migration/qa clause requires', () => {
    const input = [
      clause('F.1', 'ingestion'),
      clause('F.5', 'feature', ['EXISTING']),
      clause('F.6', 'infrastructure'),
      clause('F.7', 'migration'),
      clause('F.8', 'qa'),
    ];
    const { clauses, rewritten_ids } = injectIngestionGates(input);
    assert.equal(rewritten_ids.length, 0);
    assert.deepEqual(clauses.find((c) => c.id === 'F.5')!.requires, ['EXISTING']);
    assert.deepEqual(clauses.find((c) => c.id === 'F.6')!.requires, []);
    assert.deepEqual(clauses.find((c) => c.id === 'F.7')!.requires, []);
    assert.deepEqual(clauses.find((c) => c.id === 'F.8')!.requires, []);
  });
});

describe('injectIngestionGates — edge cases', () => {
  it('returns empty output for empty input', () => {
    const { clauses, ingestion_ids, rewritten_ids } = injectIngestionGates([]);
    assert.equal(clauses.length, 0);
    assert.equal(ingestion_ids.length, 0);
    assert.equal(rewritten_ids.length, 0);
  });

  it('skips self-require even if a graph clause matches an ingestion id by some coincidence', () => {
    // Defensive: a clause should never require itself. If an ingestion id
    // somehow matches a graph clause id (impossible under correct typing but
    // cheap to guard), the gate must not produce a self-cycle.
    const input = [
      { id: 'DUP', clause_type: 'ingestion', requires: [] },
      { id: 'DUP', clause_type: 'graph', requires: [] },
    ];
    const { clauses } = injectIngestionGates(input);
    const graphOne = clauses.find((c) => c.clause_type === 'graph')!;
    assert.equal(graphOne.requires.includes('DUP'), false);
  });
});
