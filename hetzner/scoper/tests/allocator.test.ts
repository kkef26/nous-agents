// NOUS.IDLOCK.5 — Allocator client unit tests.
//
// Covers the three states the clause body requires:
//   1. Happy path: RPC returns N IDs, all reserved.
//   2. Placeholder response: at least one slot comes back is_placeholder=true.
//   3. RPC unavailability: throws AllocatorUnavailableError, no local fallback.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { allocateClauseIds, AllocatorUnavailableError } from '../src/allocator.js';

interface FakeRpcResult {
  data?: unknown;
  error?: { message?: string; code?: string } | null;
  throws?: unknown;
}

function fakeClient(opts: FakeRpcResult): any {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'allocate_clause_ids');
      assert.ok(args.p_feature_id);
      assert.ok(args.p_prefix);
      assert.ok(typeof args.p_count === 'number');
      if (opts.throws) throw opts.throws;
      return { data: opts.data ?? null, error: opts.error ?? null };
    },
  };
}

describe('allocateClauseIds — happy path', () => {
  it('returns N non-placeholder slots when RPC succeeds with string array', async () => {
    const client = fakeClient({ data: ['NOUS.TEST.7', 'NOUS.TEST.8', 'NOUS.TEST.9'] });
    const result = await allocateClauseIds('NOUS.TEST', 'NOUS.TEST', 3, { client });
    assert.equal(result.slots.length, 3);
    assert.deepEqual(result.slots.map((s) => s.id), ['NOUS.TEST.7', 'NOUS.TEST.8', 'NOUS.TEST.9']);
    assert.equal(result.slots.every((s) => !s.is_placeholder), true);
  });

  it('returns slots when RPC succeeds with object rows carrying is_placeholder=false', async () => {
    const client = fakeClient({
      data: [
        { id: 'AXO.99.1', is_placeholder: false },
        { id: 'AXO.99.2', is_placeholder: false },
      ],
    });
    const result = await allocateClauseIds('AXO.99', 'AXO.99', 2, { client });
    assert.equal(result.slots.length, 2);
    assert.deepEqual(result.slots.map((s) => s.id), ['AXO.99.1', 'AXO.99.2']);
  });

  it('returns empty slots when count is zero (no RPC call needed)', async () => {
    let called = false;
    const client = { rpc: async () => { called = true; return { data: [], error: null }; } } as any;
    const result = await allocateClauseIds('AXO.99', 'AXO.99', 0, { client });
    assert.equal(result.slots.length, 0);
    assert.equal(called, false);
  });
});

describe('allocateClauseIds — placeholder response', () => {
  it('surfaces is_placeholder=true rows for the caller to skip', async () => {
    const client = fakeClient({
      data: [
        { id: 'BRO.5.1', is_placeholder: false },
        { id: 'BRO.5.2', is_placeholder: true, reason: 'already_reserved_by_concurrent_caller' },
        { id: 'BRO.5.3', is_placeholder: false },
      ],
    });
    const result = await allocateClauseIds('BRO.5', 'BRO.5', 3, { client });
    assert.equal(result.slots.length, 3);
    assert.equal(result.slots[0].is_placeholder, false);
    assert.equal(result.slots[1].is_placeholder, true);
    assert.equal(result.slots[1].reason, 'already_reserved_by_concurrent_caller');
    assert.equal(result.slots[2].is_placeholder, false);
  });

  it('treats the alternate "placeholder" key as equivalent to is_placeholder', async () => {
    const client = fakeClient({
      data: [{ id: 'BRO.5.4', placeholder: true }],
    });
    const result = await allocateClauseIds('BRO.5', 'BRO.5', 1, { client });
    assert.equal(result.slots[0].is_placeholder, true);
  });
});

describe('allocateClauseIds — RPC unavailability', () => {
  it('throws AllocatorUnavailableError when RPC returns an error object', async () => {
    const client = fakeClient({
      error: { code: '42883', message: 'function nous.allocate_clause_ids(...) does not exist' },
    });
    await assert.rejects(
      () => allocateClauseIds('NST.99', 'NST.99', 3, { client }),
      (err: unknown) => err instanceof AllocatorUnavailableError && /42883/.test((err as Error).message),
    );
  });

  it('throws AllocatorUnavailableError when the RPC call itself throws', async () => {
    const client = fakeClient({ throws: new Error('network unreachable') });
    await assert.rejects(
      () => allocateClauseIds('NST.99', 'NST.99', 3, { client }),
      (err: unknown) => err instanceof AllocatorUnavailableError && /network unreachable/.test((err as Error).message),
    );
  });

  it('throws AllocatorUnavailableError when a row is missing the id field', async () => {
    const client = fakeClient({ data: [{ is_placeholder: false }] });
    await assert.rejects(
      () => allocateClauseIds('NST.99', 'NST.99', 1, { client }),
      (err: unknown) => err instanceof AllocatorUnavailableError && /missing id/.test((err as Error).message),
    );
  });

  it('throws on missing required arguments rather than silently allocating', async () => {
    const client = fakeClient({ data: [] });
    await assert.rejects(
      () => allocateClauseIds('', 'NST.99', 1, { client }),
      AllocatorUnavailableError,
    );
    await assert.rejects(
      () => allocateClauseIds('NST.99', '', 1, { client }),
      AllocatorUnavailableError,
    );
  });
});
