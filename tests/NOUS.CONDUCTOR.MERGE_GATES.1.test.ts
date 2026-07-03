// NOUS.CONDUCTOR.MERGE_GATES.1 — merge-gate unit tests.
//
// Covers:
//   AC1 named-export shape (fetchStagingHead is independently importable
//       and mockable — not inlined into the orchestrator body)
//   AC2 fetchStagingHead happy path (200 + object.sha → returns sha)
//   AC3 fetchStagingHead non-2xx → throws (never downgraded to warning)
//   AC4 fetchStagingHead network error → throws
//   AC5 merge abort on fetch failure — PATCH request is never issued
//   AC6 stale-SHA replacement — each merge invocation refetches HEAD;
//       a value observed in a prior call is never reused
//   AC7 409 conflict → MergeResult.status === 'merge_conflict', conductor_log
//       receives a merge_conflict entry, no 'merged' status is ever returned
//   AC8 200 merged path → MergeResult.status === 'merged' with fresh baseSha

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  fetchStagingHead,
  mergeToStaging,
  StagingHeadFetchError,
  MergeApiError,
} from '../apps/conductor/src/merge.js';
import type {
  ConductorLogSink,
  MergeToStagingArgs,
} from '../apps/conductor/src/merge.js';
import type { MergeResult } from '../apps/conductor/src/types.js';

// -----------------------------------------------------------------------------
// helpers

interface FakeResp {
  status: number;
  bodyJson?: unknown;
  bodyText?: string;
}

function fakeFetch(routes: Record<string, FakeResp | (() => FakeResp)>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string }>;
} {
  const calls: Array<{ url: string; method: string }> = [];
  const impl: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const key = `${method} ${url}`;
    const entry = routes[key] ?? routes[url];
    if (!entry) {
      throw new Error(`fakeFetch: no route for ${key}`);
    }
    const resolved = typeof entry === 'function' ? entry() : entry;
    const body = resolved.bodyText ?? JSON.stringify(resolved.bodyJson ?? {});
    return new Response(body, {
      status: resolved.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: impl, calls };
}

function collectingLog(): ConductorLogSink & {
  entries: Array<Record<string, unknown>>;
} {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    async writeMergeConflict(entry) {
      entries.push({ ...entry });
    },
  };
}

const REPO = 'kkef26/nous-agents';
const TOKEN = 'ghp_faketoken';
const STAGING_URL =
  `https://api.github.com/repos/${REPO}/git/refs/heads/staging`;

function baseArgs(over: Partial<MergeToStagingArgs> = {}): MergeToStagingArgs {
  return {
    repo: REPO,
    clauseId: 'NOUS.CONDUCTOR.MERGE_GATES.1',
    dispatchId: 'dispatch-1',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    githubToken: TOKEN,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// AC1 — named export shape

describe('AC1 named-export shape', () => {
  it('fetchStagingHead is exported from apps/conductor/src/merge.ts as a named function', () => {
    assert.equal(typeof fetchStagingHead, 'function');
    assert.equal(fetchStagingHead.name, 'fetchStagingHead');
  });

  it('mergeToStaging is exported and independently callable', () => {
    assert.equal(typeof mergeToStaging, 'function');
  });

  it('StagingHeadFetchError is exported', () => {
    assert.equal(typeof StagingHeadFetchError, 'function');
    const err = new StagingHeadFetchError('x');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'StagingHeadFetchError');
  });
});

// -----------------------------------------------------------------------------
// AC2 — fetchStagingHead happy path

describe('AC2 fetchStagingHead happy path', () => {
  it('returns object.sha on 200', async () => {
    const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const { fetch, calls } = fakeFetch({
      [`GET ${STAGING_URL}`]: {
        status: 200,
        bodyJson: { object: { sha, type: 'commit' } },
      },
    });
    const result = await fetchStagingHead({
      repo: REPO,
      githubToken: TOKEN,
      fetchImpl: fetch,
    });
    assert.equal(result, sha);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, STAGING_URL);
  });
});

// -----------------------------------------------------------------------------
// AC3 — non-2xx throws (constraint #5: never downgrade)

describe('AC3 fetchStagingHead non-2xx throws StagingHeadFetchError', () => {
  it('404 → throws with status 404 (no swallow, no warning)', async () => {
    const { fetch } = fakeFetch({
      [`GET ${STAGING_URL}`]: {
        status: 404,
        bodyJson: { message: 'Not Found' },
      },
    });
    await assert.rejects(
      () =>
        fetchStagingHead({ repo: REPO, githubToken: TOKEN, fetchImpl: fetch }),
      (err: unknown) => {
        assert.ok(err instanceof StagingHeadFetchError);
        assert.equal((err as StagingHeadFetchError).status, 404);
        return true;
      },
    );
  });

  it('500 → throws with status 500', async () => {
    const { fetch } = fakeFetch({
      [`GET ${STAGING_URL}`]: { status: 500, bodyText: 'server exploded' },
    });
    await assert.rejects(
      () =>
        fetchStagingHead({ repo: REPO, githubToken: TOKEN, fetchImpl: fetch }),
      StagingHeadFetchError,
    );
  });

  it('200 with missing object.sha → throws', async () => {
    const { fetch } = fakeFetch({
      [`GET ${STAGING_URL}`]: { status: 200, bodyJson: { object: {} } },
    });
    await assert.rejects(
      () =>
        fetchStagingHead({ repo: REPO, githubToken: TOKEN, fetchImpl: fetch }),
      StagingHeadFetchError,
    );
  });
});

// -----------------------------------------------------------------------------
// AC4 — network error propagates

describe('AC4 fetchStagingHead network error throws', () => {
  it('fetchImpl that rejects → StagingHeadFetchError propagates', async () => {
    const boom: typeof fetch = async () => {
      throw new Error('ECONNRESET');
    };
    await assert.rejects(
      () =>
        fetchStagingHead({ repo: REPO, githubToken: TOKEN, fetchImpl: boom }),
      (err: unknown) => {
        assert.ok(err instanceof StagingHeadFetchError);
        assert.match(
          (err as StagingHeadFetchError).message,
          /ECONNRESET/,
        );
        return true;
      },
    );
  });
});

// -----------------------------------------------------------------------------
// AC5 — merge aborts on fetch failure (PATCH never issued)

describe('AC5 mergeToStaging aborts when fetchStagingHead throws', () => {
  it('fetchStagingHead throws → PATCH request never made', async () => {
    let patchCalls = 0;
    const spyFetch: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        patchCalls++;
      }
      return new Response('{}', { status: 200 });
    };
    const throwingHead: typeof fetchStagingHead = async () => {
      throw new StagingHeadFetchError('boom', 500);
    };

    await assert.rejects(
      () =>
        mergeToStaging(baseArgs(), {
          fetchImpl: spyFetch,
          fetchStagingHead: throwingHead,
        }),
      (err: unknown) => {
        assert.ok(err instanceof StagingHeadFetchError);
        return true;
      },
    );
    assert.equal(
      patchCalls,
      0,
      'PATCH must NOT be issued when fetchStagingHead throws',
    );
  });

  it('fetchStagingHead error propagates unchanged (never downgraded)', async () => {
    const original = new StagingHeadFetchError('specific 502', 502);
    const throwingHead: typeof fetchStagingHead = async () => {
      throw original;
    };
    await assert.rejects(
      () =>
        mergeToStaging(baseArgs(), {
          fetchImpl: (async () =>
            new Response('{}', { status: 200 })) as typeof fetch,
          fetchStagingHead: throwingHead,
        }),
      (err: unknown) => {
        assert.equal(err, original, 'exact error identity preserved');
        return true;
      },
    );
  });
});

// -----------------------------------------------------------------------------
// AC6 — stale-SHA replacement (fresh fetch per invocation)

describe('AC6 stale-SHA replacement — fresh fetch per merge invocation', () => {
  it('two mergeToStaging calls in sequence perform two GET refs calls', async () => {
    let getCount = 0;
    const shas = [
      '1111111111111111111111111111111111111111',
      '2222222222222222222222222222222222222222',
    ];
    const spyFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : (input as URL).toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && url === STAGING_URL) {
        const sha = shas[getCount++]!;
        return new Response(
          JSON.stringify({ object: { sha, type: 'commit' } }),
          { status: 200 },
        );
      }
      if (method === 'PATCH' && url === STAGING_URL) {
        return new Response(JSON.stringify({ object: { sha: 'merged' } }), {
          status: 200,
        });
      }
      throw new Error(`unrouted ${method} ${url}`);
    };

    const r1 = await mergeToStaging(baseArgs(), { fetchImpl: spyFetch });
    const r2 = await mergeToStaging(baseArgs(), { fetchImpl: spyFetch });

    assert.equal(r1.status, 'merged');
    assert.equal(r2.status, 'merged');
    if (r1.status === 'merged' && r2.status === 'merged') {
      assert.equal(r1.base_sha, shas[0]);
      assert.equal(r2.base_sha, shas[1]);
      assert.notEqual(
        r1.base_sha,
        r2.base_sha,
        'each invocation must observe the fresh live head, not a cached value',
      );
    }
    assert.equal(getCount, 2, 'GET refs/heads/staging must be called twice');
  });

  it('fetchStagingHead is called BEFORE the PATCH request within a single merge', async () => {
    const order: string[] = [];
    const headFn: typeof fetchStagingHead = async () => {
      order.push('fetchStagingHead');
      return '3333333333333333333333333333333333333333';
    };
    const spyFetch: typeof fetch = async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH') order.push('PATCH');
      return new Response(JSON.stringify({ object: { sha: 'merged' } }), {
        status: 200,
      });
    };
    await mergeToStaging(baseArgs(), {
      fetchImpl: spyFetch,
      fetchStagingHead: headFn,
    });
    assert.deepEqual(order, ['fetchStagingHead', 'PATCH']);
  });
});

// -----------------------------------------------------------------------------
// AC7 — 409 conflict handling

describe('AC7 409 → merge_conflict recorded, clause NOT advanced', () => {
  it('409 → status merge_conflict, log entry written, no merged status', async () => {
    const sha = '4444444444444444444444444444444444444444';
    const spyFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string'
        ? input
        : (input as URL).toString();
      if (method === 'GET' && url === STAGING_URL) {
        return new Response(
          JSON.stringify({ object: { sha, type: 'commit' } }),
          { status: 200 },
        );
      }
      if (method === 'PATCH' && url === STAGING_URL) {
        return new Response(
          JSON.stringify({ message: 'Update is not a fast forward' }),
          { status: 409 },
        );
      }
      throw new Error(`unrouted ${method} ${url}`);
    };

    const log = collectingLog();
    const result: MergeResult = await mergeToStaging(baseArgs(), {
      fetchImpl: spyFetch,
      conductorLog: log,
    });

    assert.equal(result.status, 'merge_conflict');
    assert.notEqual(
      result.status,
      'merged',
      'a 409 response MUST NOT ever yield a merged verdict (constraint #4)',
    );
    if (result.status === 'merge_conflict') {
      assert.equal(result.base_sha, sha);
      assert.match(result.message, /fast forward/);
    }
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]!.clause_id, 'NOUS.CONDUCTOR.MERGE_GATES.1');
    assert.equal(log.entries[0]!.base_sha, sha);
  });

  it('non-4xx/5xx merge PATCH response → MergeApiError thrown', async () => {
    const sha = '5555555555555555555555555555555555555555';
    const spyFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string'
        ? input
        : (input as URL).toString();
      if (method === 'GET' && url === STAGING_URL) {
        return new Response(
          JSON.stringify({ object: { sha, type: 'commit' } }),
          { status: 200 },
        );
      }
      return new Response('teapot', { status: 418 });
    };
    await assert.rejects(
      () => mergeToStaging(baseArgs(), { fetchImpl: spyFetch }),
      MergeApiError,
    );
  });
});

// -----------------------------------------------------------------------------
// AC8 — 200 merged path

describe('AC8 200 merged path — fresh baseSha reported', () => {
  it('200 → status merged, base_sha === live fetched head', async () => {
    const sha = '6666666666666666666666666666666666666666';
    const spyFetch: typeof fetch = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = typeof input === 'string'
        ? input
        : (input as URL).toString();
      if (method === 'GET' && url === STAGING_URL) {
        return new Response(
          JSON.stringify({ object: { sha, type: 'commit' } }),
          { status: 200 },
        );
      }
      if (method === 'PATCH' && url === STAGING_URL) {
        return new Response(
          JSON.stringify({ object: { sha: 'aaaabbbb', type: 'commit' } }),
          { status: 200 },
        );
      }
      throw new Error(`unrouted ${method} ${url}`);
    };
    const result = await mergeToStaging(baseArgs(), { fetchImpl: spyFetch });
    assert.equal(result.status, 'merged');
    if (result.status === 'merged') {
      assert.equal(result.base_sha, sha);
      assert.equal(result.merged_sha, 'aaaabbbb');
      assert.equal(result.head_sha, baseArgs().headSha);
    }
  });
});
