// NOUS.CONDUCTOR.MERGE_GATES.3 — pre-swap smoke-gate unit tests.
//
// Covers the 5 constraints in the clause body:
//   C1 swapDist NEVER called unless runSmokeGate returns
//      status === 'smoke_passed'
//   C2 temporary local serve process NEVER lingers past runSmokeGate
//      resolution — teardown in both success and failure paths
//   C3 headless process non-zero exit is NEVER treated as a pass,
//      even when zero console errors were captured
//   C4 runSmokeGate + swapDist are independently importable named
//      exports, NEVER inlined into the conductor orchestrator body
//   C5 clause NEVER advanced to shipped without an explicit
//      smoke_passed check on SmokeGateResult.status
//
// And the 8 acceptance criteria:
//   AC1 happy path → smoke_passed + swapDist called exactly once
//       with new dist path as source
//   AC2 non-200 index → smoke_failed reason 'http_check_failed'
//   AC3 console errors → smoke_failed reason 'headless_mount_error'
//   AC4 serve process torn down on pass AND fail
//   AC5 smoke_failed → verification_pending + decision_queue row
//       carrying clause_id, reason, timestamp; existing served dist
//       untouched
//   AC6 headless timeout → smoke_failed reason 'headless_timeout',
//       serve torn down, swap never called
//   AC7 config env vars override each field independently
//   AC8 SmokeGateResult union covers exactly smoke_passed |
//       smoke_failed, smoke_failed carries non-optional reason typed
//       to the three literal fail reasons; TS structural rejection is
//       covered by tsc --noEmit + a compile-time surface probe below.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  runSmokeGate,
  HEADLESS_TIMEOUT,
  type RunSmokeGateArgs,
  type RunSmokeGateDeps,
  type ServeHandle,
  type HeadlessCheckResult,
} from '../apps/conductor/src/smoke-gate.js';
import { swapDist } from '../apps/conductor/src/dist-swap.js';
import type {
  SmokeGateResult,
  SmokeFailReason,
  BuildGateResult,
  MergeResult,
} from '../apps/conductor/src/types.js';
import {
  DEFAULT_SMOKE_GATE_CONFIG,
  SMOKE_GATE_ENV_KEYS,
  defaultConductorConfig,
  loadSmokeGateConfig,
  type SmokeGateConfig,
} from '../apps/conductor/src/config.js';
import {
  runConductor,
  type ConductorRunArgs,
  type ConductorRunDeps,
  type SmokeGateFailureSink,
} from '../apps/conductor/src/conductor.js';

// -----------------------------------------------------------------------------
// fakes

interface ServeCall {
  distPath: string;
  port: number;
}

interface FakeServeState {
  serve: NonNullable<RunSmokeGateDeps['serveImpl']>;
  calls: ServeCall[];
  /** Total teardown() invocations across all handles this fake handed out. */
  teardowns: number;
}

function fakeServe(): FakeServeState {
  const state: FakeServeState = {
    calls: [],
    teardowns: 0,
    serve: async () => ({ async teardown() {} }),
  };
  state.serve = async (distPath, port) => {
    state.calls.push({ distPath, port });
    const handle: ServeHandle = {
      async teardown() {
        state.teardowns++;
      },
    };
    return handle;
  };
  return state;
}

function fakeHttp(
  status: number,
): {
  httpCheck: NonNullable<RunSmokeGateDeps['httpCheckImpl']>;
  calls: string[];
} {
  const calls: string[] = [];
  const httpCheck: NonNullable<RunSmokeGateDeps['httpCheckImpl']> = async (
    url,
  ) => {
    calls.push(url);
    return { status };
  };
  return { httpCheck, calls };
}

function fakeHeadless(
  result: HeadlessCheckResult,
): {
  headless: NonNullable<RunSmokeGateDeps['headlessCheckImpl']>;
  calls: Array<{ url: string; timeoutMs: number }>;
} {
  const calls: Array<{ url: string; timeoutMs: number }> = [];
  const headless: NonNullable<RunSmokeGateDeps['headlessCheckImpl']> = async (
    url,
    timeoutMs,
  ) => {
    calls.push({ url, timeoutMs });
    return result;
  };
  return { headless, calls };
}

function fakeSwap(): {
  swap: NonNullable<RunSmokeGateDeps['swapDistImpl']>;
  calls: Array<{ source: string; dest: string }>;
} {
  const calls: Array<{ source: string; dest: string }> = [];
  const swap: NonNullable<RunSmokeGateDeps['swapDistImpl']> = async (args) => {
    calls.push({ source: args.source, dest: args.dest });
  };
  return { swap, calls };
}

const NEW_DIST = '/opt/staging/checkout/dist';
const SERVED_DIST = '/var/www/served/dist';

function baseArgs(over: Partial<RunSmokeGateArgs> = {}): RunSmokeGateArgs {
  return {
    newDistPath: NEW_DIST,
    servedDistPath: SERVED_DIST,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// C4 — named-export shape

describe('C4 named-export shape — runSmokeGate + swapDist not inlined', () => {
  it('runSmokeGate is exported as a named function from smoke-gate.ts', () => {
    assert.equal(typeof runSmokeGate, 'function');
    assert.equal(runSmokeGate.name, 'runSmokeGate');
  });

  it('swapDist is exported as a named function from dist-swap.ts', () => {
    assert.equal(typeof swapDist, 'function');
    assert.equal(swapDist.name, 'swapDist');
  });

  it('HEADLESS_TIMEOUT sentinel is exported as a stable literal', () => {
    assert.equal(HEADLESS_TIMEOUT, 'headless_timeout');
  });
});

// -----------------------------------------------------------------------------
// AC1 — happy path

describe('AC1 happy path — 200 index + zero console errors → smoke_passed', () => {
  it('returns { status: "smoke_passed" } and calls swapDist exactly once with newDistPath as source', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();

    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });

    assert.equal(result.status, 'smoke_passed');
    assert.equal(swap.calls.length, 1);
    assert.equal(swap.calls[0]!.source, NEW_DIST);
    assert.equal(swap.calls[0]!.dest, SERVED_DIST);
  });

  it('serve was started rooted at newDistPath on config.servePort', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(serve.calls.length, 1);
    assert.equal(serve.calls[0]!.distPath, NEW_DIST);
    assert.equal(serve.calls[0]!.port, DEFAULT_SMOKE_GATE_CONFIG.servePort);
  });

  it('http probe hits index of the local serve URL', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(http.calls.length, 1);
    assert.match(http.calls[0]!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it('headless probe hits the entry route URL and receives the timeout', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    const config: SmokeGateConfig = {
      entryRoute: '/board',
      servePort: 4321,
      headlessTimeoutMs: 8000,
    };
    await runSmokeGate(baseArgs({ config }), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(headless.calls.length, 1);
    assert.equal(headless.calls[0]!.url, 'http://127.0.0.1:4321/board');
    assert.equal(headless.calls[0]!.timeoutMs, 8000);
  });
});

// -----------------------------------------------------------------------------
// AC2 — http 200 gate

describe('AC2 non-200 index → smoke_failed reason "http_check_failed"', () => {
  it('returns SmokeGateResult { status: "smoke_failed", reason: "http_check_failed" }', async () => {
    const serve = fakeServe();
    const http = fakeHttp(500);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(result.status, 'smoke_failed');
    if (result.status === 'smoke_failed') {
      assert.equal(result.reason, 'http_check_failed');
    }
  });

  it('swapDist is NEVER called when http probe returns non-200', async () => {
    const serve = fakeServe();
    const http = fakeHttp(502);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(swap.calls.length, 0);
  });

  it('headless probe is skipped after http_check_failed (short-circuit)', async () => {
    const serve = fakeServe();
    const http = fakeHttp(404);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(headless.calls.length, 0);
  });
});

// -----------------------------------------------------------------------------
// AC3 — headless console errors

describe('AC3 console errors → smoke_failed reason "headless_mount_error"', () => {
  it('exitCode 0 + non-empty consoleErrors → smoke_failed / headless_mount_error', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({
      exitCode: 0,
      consoleErrors: ['ReferenceError: x is not defined at App.tsx:4'],
    });
    const swap = fakeSwap();
    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(result.status, 'smoke_failed');
    if (result.status === 'smoke_failed') {
      assert.equal(result.reason, 'headless_mount_error');
    }
    assert.equal(swap.calls.length, 0);
  });
});

// -----------------------------------------------------------------------------
// C3 — non-zero exit is NEVER a pass, even with zero console errors

describe('C3 non-zero headless exit → NEVER treated as pass', () => {
  it('exitCode 1 + empty consoleErrors → smoke_failed / headless_mount_error, swap not called', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 1, consoleErrors: [] });
    const swap = fakeSwap();
    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(result.status, 'smoke_failed');
    if (result.status === 'smoke_failed') {
      assert.equal(result.reason, 'headless_mount_error');
    }
    assert.equal(swap.calls.length, 0);
  });

  it('exitCode -1 (crash) + empty consoleErrors → smoke_failed, swap not called', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: -1, consoleErrors: [] });
    const swap = fakeSwap();
    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(result.status, 'smoke_failed');
    assert.equal(swap.calls.length, 0);
  });
});

// -----------------------------------------------------------------------------
// AC4 + C2 — serve teardown on pass AND fail

describe('AC4 / C2 serve teardown — process torn down in both success and failure', () => {
  it('teardown fires exactly once on the smoke_passed branch', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(serve.teardowns, 1);
  });

  it('teardown fires exactly once on the http_check_failed branch', async () => {
    const serve = fakeServe();
    const http = fakeHttp(503);
    const headless = fakeHeadless({ exitCode: 0, consoleErrors: [] });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(serve.teardowns, 1);
  });

  it('teardown fires exactly once on the headless_mount_error branch', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless({
      exitCode: 0,
      consoleErrors: ['boom'],
    });
    const swap = fakeSwap();
    await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(serve.teardowns, 1);
  });

  it('teardown fires exactly once even when the headless impl throws mid-flight', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const throwingHeadless: NonNullable<
      RunSmokeGateDeps['headlessCheckImpl']
    > = async () => {
      throw new Error('crashed');
    };
    const swap = fakeSwap();
    await assert.rejects(
      runSmokeGate(baseArgs(), {
        serveImpl: serve.serve,
        httpCheckImpl: http.httpCheck,
        headlessCheckImpl: throwingHeadless,
        swapDistImpl: swap.swap,
      }),
    );
    assert.equal(serve.teardowns, 1);
    assert.equal(swap.calls.length, 0);
  });
});

// -----------------------------------------------------------------------------
// AC6 — headless timeout

describe('AC6 headless timeout → smoke_failed reason "headless_timeout"', () => {
  it('HEADLESS_TIMEOUT sentinel → smoke_failed, serve torn down, swap not called', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless(HEADLESS_TIMEOUT);
    const swap = fakeSwap();
    const result = await runSmokeGate(baseArgs(), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(result.status, 'smoke_failed');
    if (result.status === 'smoke_failed') {
      assert.equal(result.reason, 'headless_timeout');
    }
    assert.equal(serve.teardowns, 1);
    assert.equal(swap.calls.length, 0);
  });

  it('config.headlessTimeoutMs is passed through to the headless impl', async () => {
    const serve = fakeServe();
    const http = fakeHttp(200);
    const headless = fakeHeadless(HEADLESS_TIMEOUT);
    const swap = fakeSwap();
    const config: SmokeGateConfig = {
      entryRoute: '/',
      servePort: 4099,
      headlessTimeoutMs: 250,
    };
    await runSmokeGate(baseArgs({ config }), {
      serveImpl: serve.serve,
      httpCheckImpl: http.httpCheck,
      headlessCheckImpl: headless.headless,
      swapDistImpl: swap.swap,
    });
    assert.equal(headless.calls[0]!.timeoutMs, 250);
  });
});

// -----------------------------------------------------------------------------
// AC7 — config defaults + env overrides

describe('AC7 config defaults + env overrides', () => {
  it('DEFAULT_SMOKE_GATE_CONFIG.entryRoute is "/"', () => {
    assert.equal(DEFAULT_SMOKE_GATE_CONFIG.entryRoute, '/');
  });

  it('DEFAULT_SMOKE_GATE_CONFIG.servePort is 4099', () => {
    assert.equal(DEFAULT_SMOKE_GATE_CONFIG.servePort, 4099);
  });

  it('DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs is 15000', () => {
    assert.equal(DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs, 15000);
  });

  it('loadSmokeGateConfig() with empty env returns the defaults', () => {
    const cfg = loadSmokeGateConfig({});
    assert.deepEqual(cfg, DEFAULT_SMOKE_GATE_CONFIG);
  });

  it('entryRoute env override applies independently of the numeric fields', () => {
    const cfg = loadSmokeGateConfig({
      [SMOKE_GATE_ENV_KEYS.entryRoute]: '/board',
    });
    assert.equal(cfg.entryRoute, '/board');
    assert.equal(cfg.servePort, DEFAULT_SMOKE_GATE_CONFIG.servePort);
    assert.equal(
      cfg.headlessTimeoutMs,
      DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs,
    );
  });

  it('servePort env override applies independently', () => {
    const cfg = loadSmokeGateConfig({
      [SMOKE_GATE_ENV_KEYS.servePort]: '5199',
    });
    assert.equal(cfg.servePort, 5199);
    assert.equal(cfg.entryRoute, DEFAULT_SMOKE_GATE_CONFIG.entryRoute);
    assert.equal(
      cfg.headlessTimeoutMs,
      DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs,
    );
  });

  it('headlessTimeoutMs env override applies independently', () => {
    const cfg = loadSmokeGateConfig({
      [SMOKE_GATE_ENV_KEYS.headlessTimeoutMs]: '25000',
    });
    assert.equal(cfg.headlessTimeoutMs, 25000);
    assert.equal(cfg.entryRoute, DEFAULT_SMOKE_GATE_CONFIG.entryRoute);
    assert.equal(cfg.servePort, DEFAULT_SMOKE_GATE_CONFIG.servePort);
  });

  it('malformed numeric env falls back to the default (never NaN)', () => {
    const cfg = loadSmokeGateConfig({
      [SMOKE_GATE_ENV_KEYS.servePort]: 'not-a-port',
      [SMOKE_GATE_ENV_KEYS.headlessTimeoutMs]: 'nope',
    });
    assert.equal(cfg.servePort, DEFAULT_SMOKE_GATE_CONFIG.servePort);
    assert.equal(
      cfg.headlessTimeoutMs,
      DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs,
    );
  });

  it('defaultConductorConfig.smokeGate is the DEFAULT_SMOKE_GATE_CONFIG object', () => {
    assert.equal(defaultConductorConfig.smokeGate, DEFAULT_SMOKE_GATE_CONFIG);
  });
});

// -----------------------------------------------------------------------------
// AC8 — SmokeGateResult union shape (compile-time + runtime probe)

describe('AC8 SmokeGateResult union shape — smoke_passed | smoke_failed with non-optional reason', () => {
  it('smoke_passed value has no reason field', () => {
    const passed: SmokeGateResult = { status: 'smoke_passed' };
    assert.equal(passed.status, 'smoke_passed');
    assert.equal('reason' in passed, false);
  });

  it('smoke_failed value carries reason typed as one of the three literals', () => {
    const reasons: SmokeFailReason[] = [
      'http_check_failed',
      'headless_mount_error',
      'headless_timeout',
    ];
    for (const reason of reasons) {
      const failed: SmokeGateResult = { status: 'smoke_failed', reason };
      assert.equal(failed.status, 'smoke_failed');
      if (failed.status === 'smoke_failed') {
        // Compile-time invariant: TS narrows `reason` to the literal union.
        // Runtime probe: reason must be one of the three literals.
        assert.ok(reasons.includes(failed.reason));
      }
    }
  });

  it('exhaustive narrowing — switch on status covers exactly two arms', () => {
    // This test doubles as a compile-time invariant. If the union grows
    // to a third arm, the default: never assertion fails to compile.
    const cases: SmokeGateResult[] = [
      { status: 'smoke_passed' },
      { status: 'smoke_failed', reason: 'http_check_failed' },
    ];
    for (const c of cases) {
      switch (c.status) {
        case 'smoke_passed':
          assert.equal(c.status, 'smoke_passed');
          break;
        case 'smoke_failed':
          assert.equal(typeof c.reason, 'string');
          break;
        default: {
          const exhaustive: never = c;
          throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  });
});

// -----------------------------------------------------------------------------
// AC5 + C5 — conductor wiring: verification_pending + decision_queue on
// smoke_failed, shipped only on explicit smoke_passed

describe('AC5 / C5 conductor wiring — verification_pending on failure, shipped only on smoke_passed', () => {
  const MERGED: MergeResult = {
    status: 'merged',
    merged_sha: 'aabbccdd',
    base_sha: '11112222',
    head_sha: '33334444',
  };
  const PASSING_BUILD: BuildGateResult = {
    status: 'passed',
    tsc: { exit_code: 0, stdout: '', stderr: '' },
    build: { exit_code: 0, stdout: '', stderr: '' },
  };

  function baseConductorArgs(
    over: Partial<ConductorRunArgs> = {},
  ): ConductorRunArgs {
    return {
      repo: 'kkef26/nous-agents',
      clauseId: 'NOUS.CONDUCTOR.MERGE_GATES.3',
      dispatchId: 'dispatch-3',
      headSha: '33334444',
      githubToken: 'ghp_faketoken',
      workingDir: '/opt/staging/checkout',
      newDistPath: NEW_DIST,
      servedDistPath: SERVED_DIST,
      ...over,
    };
  }

  it('smoke_passed → shipped, smokeGate carried through, clauseStatus NOT verification_pending', async () => {
    const passing: SmokeGateResult = { status: 'smoke_passed' };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => passing,
    });
    assert.equal(result.status, 'shipped');
    if (result.status === 'shipped') {
      assert.equal(result.smokeGate.status, 'smoke_passed');
    }
  });

  it('http_check_failed → smoke_gate_failed with clauseStatus verification_pending', async () => {
    const failing: SmokeGateResult = {
      status: 'smoke_failed',
      reason: 'http_check_failed',
    };
    const sink: SmokeGateFailureSink & {
      entries: Array<Record<string, unknown>>;
    } = {
      entries: [],
      async writeSmokeGateFailure(entry) {
        this.entries.push({ ...entry });
      },
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => failing,
      smokeGateFailureSink: sink,
      nowImpl: () => '2026-07-03T12:00:00.000Z',
    });
    assert.equal(result.status, 'smoke_gate_failed');
    assert.notEqual(result.status, 'shipped');
    if (result.status === 'smoke_gate_failed') {
      assert.equal(result.clauseStatus, 'verification_pending');
      assert.equal(result.smokeGate.status, 'smoke_failed');
    }
    // decision_queue row carries clause_id, reason, timestamp
    assert.equal(sink.entries.length, 1);
    const row = sink.entries[0]!;
    assert.equal(row.clause_id, 'NOUS.CONDUCTOR.MERGE_GATES.3');
    assert.equal(row.reason, 'http_check_failed');
    assert.equal(row.clause_status, 'verification_pending');
    assert.equal(typeof row.timestamp, 'string');
    assert.notEqual(row.timestamp, null);
    assert.notEqual((row.timestamp as string).length, 0);
  });

  it('headless_mount_error → sink row carries reason "headless_mount_error"', async () => {
    const failing: SmokeGateResult = {
      status: 'smoke_failed',
      reason: 'headless_mount_error',
    };
    const sink: SmokeGateFailureSink & {
      entries: Array<Record<string, unknown>>;
    } = {
      entries: [],
      async writeSmokeGateFailure(entry) {
        this.entries.push({ ...entry });
      },
    };
    await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => failing,
      smokeGateFailureSink: sink,
      nowImpl: () => '2026-07-03T12:00:01.000Z',
    });
    assert.equal(sink.entries[0]!.reason, 'headless_mount_error');
  });

  it('headless_timeout → sink row carries reason "headless_timeout"', async () => {
    const failing: SmokeGateResult = {
      status: 'smoke_failed',
      reason: 'headless_timeout',
    };
    const sink: SmokeGateFailureSink & {
      entries: Array<Record<string, unknown>>;
    } = {
      entries: [],
      async writeSmokeGateFailure(entry) {
        this.entries.push({ ...entry });
      },
    };
    await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => failing,
      smokeGateFailureSink: sink,
      nowImpl: () => '2026-07-03T12:00:02.000Z',
    });
    assert.equal(sink.entries[0]!.reason, 'headless_timeout');
  });

  it('smoke gate NEVER runs when build gate failed (upstream shortcut)', async () => {
    let smokeInvoked = 0;
    const failedBuild: BuildGateResult = {
      status: 'tsc_failed',
      build_output: { exit_code: 2, stdout: 'err', stderr: 'ts' },
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => failedBuild,
      smokeGateImpl: async () => {
        smokeInvoked++;
        return { status: 'smoke_passed' };
      },
    });
    assert.equal(smokeInvoked, 0);
    assert.equal(result.status, 'build_gate_failed');
  });

  it('smoke gate NEVER runs when merge did not merge', async () => {
    let smokeInvoked = 0;
    const conflict: MergeResult = {
      status: 'merge_conflict',
      base_sha: '11112222',
      head_sha: '33334444',
      message: 'not fast forward',
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => conflict,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => {
        smokeInvoked++;
        return { status: 'smoke_passed' };
      },
    });
    assert.equal(smokeInvoked, 0);
    assert.equal(result.status, 'not_merged');
  });

  it('smoke gate receives newDistPath + servedDistPath + config from conductor args', async () => {
    let observed: {
      newDistPath?: string;
      servedDistPath?: string;
      cfg?: SmokeGateConfig;
    } = {};
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async (a) => {
        observed = {
          newDistPath: a.newDistPath,
          servedDistPath: a.servedDistPath,
          cfg: a.config,
        };
        return { status: 'smoke_passed' };
      },
    });
    assert.equal(result.status, 'shipped');
    assert.equal(observed.newDistPath, NEW_DIST);
    assert.equal(observed.servedDistPath, SERVED_DIST);
    assert.equal(observed.cfg?.entryRoute, DEFAULT_SMOKE_GATE_CONFIG.entryRoute);
    assert.equal(observed.cfg?.servePort, DEFAULT_SMOKE_GATE_CONFIG.servePort);
  });

  it('C5 shipped is only produced when SmokeGateResult.status === "smoke_passed" (fabricated invalid status stays out of shipped)', async () => {
    // Fabricate an invalid status via cast — proves that any non-literal
    // value fails the explicit === check in conductor.ts.
    const bogus = { status: 'unexpected' } as unknown as SmokeGateResult;
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => PASSING_BUILD,
      smokeGateImpl: async () => bogus,
    });
    assert.notEqual(result.status, 'shipped');
    assert.equal(result.status, 'smoke_gate_failed');
  });
});
