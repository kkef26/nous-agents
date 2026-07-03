// NOUS.CONDUCTOR.MERGE_GATES.2 — post-merge build-gate unit tests.
//
// Covers the 5 constraints in the clause body:
//   C1 build gate NEVER runs against any tree state other than the
//      post-merge staging checkout (workingDir enforcement)
//   C2 build gate NEVER advances to a shipped verdict when either
//      phase exits non-zero
//   C3 stdout AND stderr from a failing command are NEVER discarded —
//      both propagate through BuildGateResult.build_output
//   C4 tsc and vite binary paths are NEVER hardcoded — resolved
//      from ${workingDir}/node_modules/.bin/${bin} at runtime
//   C5 runBuildGate is NEVER inlined into the conductor orchestrator
//      body — it is an independently importable named export
//
// Also covers the two-phase ordering (tsc → build, build skipped on
// tsc failure) and the conductor.ts wiring (runBuildGate fires only
// after status==='merged'; a non-passed BuildGateResult never yields
// a shipped verdict).

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  runBuildGate,
  type RunBuildGateArgs,
  type RunBuildGateDeps,
  type SpawnResult,
  type BinaryResolver,
} from '../apps/conductor/src/build-gate.js';
import type {
  BuildGateResult,
  CommandOutput,
} from '../apps/conductor/src/types.js';
import {
  DEFAULT_BUILD_GATE_CONFIG,
  defaultConductorConfig,
  type BuildGateConfig,
} from '../apps/conductor/src/config.js';
import {
  runConductor,
  type ConductorRunArgs,
  type ConductorRunDeps,
  type BuildGateFailureSink,
} from '../apps/conductor/src/conductor.js';
import type { MergeResult } from '../apps/conductor/src/types.js';

// -----------------------------------------------------------------------------
// helpers

interface SpawnCall {
  bin: string;
  args: string[];
  cwd: string;
}

function fakeSpawn(
  results: Array<SpawnResult | ((call: SpawnCall) => SpawnResult)>,
): {
  spawn: NonNullable<RunBuildGateDeps['spawnImpl']>;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  let i = 0;
  const spawn: NonNullable<RunBuildGateDeps['spawnImpl']> = async (
    bin,
    args,
    opts,
  ) => {
    const call: SpawnCall = { bin, args: [...args], cwd: opts.cwd };
    calls.push(call);
    if (i >= results.length) {
      throw new Error(
        `fakeSpawn: no queued result for call #${i} ${bin} ${args.join(' ')}`,
      );
    }
    const entry = results[i++]!;
    return typeof entry === 'function' ? entry(call) : entry;
  };
  return { spawn, calls };
}

function passingResolver(): BinaryResolver {
  return async (bin, workingDir) => `${workingDir}/node_modules/.bin/${bin}`;
}

const PASS: SpawnResult = { exitCode: 0, stdout: 'ok\n', stderr: '' };
const TSC_FAIL: SpawnResult = {
  exitCode: 2,
  stdout: 'src/x.ts(1,1): error TS2304: Cannot find name.\n',
  stderr: 'Found 1 error.\n',
};
const BUILD_FAIL: SpawnResult = {
  exitCode: 1,
  stdout: 'compiling…\n',
  stderr: 'ENOENT vite.config.ts\n',
};

const WD = '/opt/staging/checkout';

function baseArgs(over: Partial<RunBuildGateArgs> = {}): RunBuildGateArgs {
  return {
    workingDir: WD,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// C5 — named-export shape (independently importable)

describe('C5 named-export shape — runBuildGate is not inlined', () => {
  it('runBuildGate is exported as a named function from build-gate.ts', () => {
    assert.equal(typeof runBuildGate, 'function');
    assert.equal(runBuildGate.name, 'runBuildGate');
  });

  it('config surface exports DEFAULT_BUILD_GATE_CONFIG and defaultConductorConfig', () => {
    assert.equal(typeof DEFAULT_BUILD_GATE_CONFIG, 'object');
    assert.ok(DEFAULT_BUILD_GATE_CONFIG.tscCommand);
    assert.ok(DEFAULT_BUILD_GATE_CONFIG.buildCommand);
    assert.equal(typeof defaultConductorConfig, 'object');
    assert.equal(defaultConductorConfig.buildGate, DEFAULT_BUILD_GATE_CONFIG);
  });

  it('runConductor is exported from conductor.ts', () => {
    assert.equal(typeof runConductor, 'function');
    assert.equal(runConductor.name, 'runConductor');
  });
});

// -----------------------------------------------------------------------------
// happy path — tsc passes then build passes

describe('happy path — tsc then build both exit 0 → passed', () => {
  it('returns status "passed" with both CommandOutputs captured', async () => {
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    const result = await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(result.status, 'passed');
    assert.equal(calls.length, 2);
    if (result.status === 'passed') {
      assert.equal(result.tsc.exit_code, 0);
      assert.equal(result.build.exit_code, 0);
    }
  });
});

// -----------------------------------------------------------------------------
// two-phase ordering — tsc runs first, build second

describe('two-phase ordering — tsc precedes build', () => {
  it('the first spawn call uses the configured tsc binary', async () => {
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(calls[0]!.bin, `${WD}/node_modules/.bin/tsc`);
    assert.deepEqual(calls[0]!.args, ['--noEmit']);
  });

  it('the second spawn call uses the configured build binary', async () => {
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(calls[1]!.bin, `${WD}/node_modules/.bin/vite`);
    assert.deepEqual(calls[1]!.args, ['build']);
  });
});

// -----------------------------------------------------------------------------
// C3 — output capture on tsc failure

describe('C3 tsc failure captures BOTH stdout and stderr under build_output', () => {
  it('non-zero tsc exit → status "tsc_failed" with full stdout+stderr', async () => {
    const { spawn, calls } = fakeSpawn([TSC_FAIL]);
    const result = await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(result.status, 'tsc_failed');
    if (result.status === 'tsc_failed') {
      assert.equal(result.build_output.exit_code, TSC_FAIL.exitCode);
      assert.equal(result.build_output.stdout, TSC_FAIL.stdout);
      assert.equal(result.build_output.stderr, TSC_FAIL.stderr);
      // stdout AND stderr both present — never discarded (constraint 3)
      assert.notEqual(result.build_output.stdout.length, 0);
      assert.notEqual(result.build_output.stderr.length, 0);
    }
    // build phase is NEVER invoked on tsc failure
    assert.equal(calls.length, 1);
  });
});

// -----------------------------------------------------------------------------
// C3 — output capture on build failure

describe('C3 build failure captures BOTH stdout and stderr under build_output', () => {
  it('tsc passes + build non-zero → status "build_failed" with full stdout+stderr', async () => {
    const { spawn, calls } = fakeSpawn([PASS, BUILD_FAIL]);
    const result = await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(result.status, 'build_failed');
    if (result.status === 'build_failed') {
      assert.equal(result.build_output.exit_code, BUILD_FAIL.exitCode);
      assert.equal(result.build_output.stdout, BUILD_FAIL.stdout);
      assert.equal(result.build_output.stderr, BUILD_FAIL.stderr);
      // The passing tsc output is also retained for context.
      assert.equal(result.tsc_output.exit_code, 0);
    }
    assert.equal(calls.length, 2);
  });
});

// -----------------------------------------------------------------------------
// C1 — working-directory enforcement

describe('C1 working-directory — both spawns cwd is args.workingDir', () => {
  it('every spawn call receives the same cwd (post-merge checkout)', async () => {
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    await runBuildGate(baseArgs({ workingDir: '/mnt/staging/tree-xyz' }), {
      spawnImpl: spawn,
      resolveBinaryImpl: async (bin, cwd) => `${cwd}/node_modules/.bin/${bin}`,
    });
    assert.equal(calls[0]!.cwd, '/mnt/staging/tree-xyz');
    assert.equal(calls[1]!.cwd, '/mnt/staging/tree-xyz');
  });
});

// -----------------------------------------------------------------------------
// C4 — binary resolution from node_modules/.bin, not hardcoded

describe('C4 binary path resolution — resolver is consulted at runtime', () => {
  it('every spawn call binary is the resolver output, not the raw bin name', async () => {
    const resolverCalls: Array<{ bin: string; cwd: string }> = [];
    const resolver: BinaryResolver = async (bin, cwd) => {
      resolverCalls.push({ bin, cwd });
      return `/custom/prefix/${bin}`;
    };
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: resolver,
    });
    assert.equal(resolverCalls.length, 2);
    assert.deepEqual(resolverCalls.map((r) => r.bin), ['tsc', 'vite']);
    resolverCalls.forEach((r) => assert.equal(r.cwd, WD));
    assert.equal(calls[0]!.bin, '/custom/prefix/tsc');
    assert.equal(calls[1]!.bin, '/custom/prefix/vite');
    // Sanity: no bare 'tsc' or 'vite' string leaked through
    assert.notEqual(calls[0]!.bin, 'tsc');
    assert.notEqual(calls[1]!.bin, 'vite');
  });

  it('missing binary in node_modules/.bin → status "setup_failed" (never runs spawn)', async () => {
    let spawnCount = 0;
    const spawn: NonNullable<RunBuildGateDeps['spawnImpl']> = async () => {
      spawnCount++;
      return PASS;
    };
    const failingResolver: BinaryResolver = async (bin, cwd) => {
      throw new Error(`ENOENT ${cwd}/node_modules/.bin/${bin}`);
    };
    const result = await runBuildGate(baseArgs(), {
      spawnImpl: spawn,
      resolveBinaryImpl: failingResolver,
    });
    assert.equal(result.status, 'setup_failed');
    if (result.status === 'setup_failed') {
      assert.match(result.reason, /ENOENT/);
    }
    // NEVER runs any command when setup fails
    assert.equal(spawnCount, 0);
  });
});

// -----------------------------------------------------------------------------
// config defaults

describe('config defaults — buildGate.tscCommand and buildGate.buildCommand', () => {
  it('DEFAULT_BUILD_GATE_CONFIG.tscCommand is { bin: "tsc", args: ["--noEmit"] }', () => {
    assert.equal(DEFAULT_BUILD_GATE_CONFIG.tscCommand.bin, 'tsc');
    assert.deepEqual(DEFAULT_BUILD_GATE_CONFIG.tscCommand.args, ['--noEmit']);
  });

  it('DEFAULT_BUILD_GATE_CONFIG.buildCommand.bin does NOT hardcode a filesystem path', () => {
    const bin = DEFAULT_BUILD_GATE_CONFIG.buildCommand.bin;
    assert.equal(typeof bin, 'string');
    assert.equal(bin.includes('/'), false);
    assert.equal(bin.includes('\\'), false);
    assert.notEqual(bin.length, 0);
  });

  it('caller-supplied config overrides defaults', async () => {
    const config: BuildGateConfig = {
      tscCommand: { bin: 'my-tsc', args: ['-p', 'tsconfig.build.json'] },
      buildCommand: { bin: 'rollup', args: ['-c'] },
    };
    const { spawn, calls } = fakeSpawn([PASS, PASS]);
    await runBuildGate(baseArgs({ config }), {
      spawnImpl: spawn,
      resolveBinaryImpl: passingResolver(),
    });
    assert.equal(calls[0]!.bin, `${WD}/node_modules/.bin/my-tsc`);
    assert.deepEqual(calls[0]!.args, ['-p', 'tsconfig.build.json']);
    assert.equal(calls[1]!.bin, `${WD}/node_modules/.bin/rollup`);
    assert.deepEqual(calls[1]!.args, ['-c']);
  });
});

// -----------------------------------------------------------------------------
// C2 — conductor wiring: build gate runs AFTER successful merge, never
// yields shipped on non-passed BuildGateResult

describe('C2 conductor wiring — build gate placement + shipped guard', () => {
  const MERGED: MergeResult = {
    status: 'merged',
    merged_sha: 'aabbccdd',
    base_sha: '11112222',
    head_sha: '33334444',
  };
  const CONFLICT: MergeResult = {
    status: 'merge_conflict',
    base_sha: '11112222',
    head_sha: '33334444',
    message: 'not fast forward',
  };

  function baseConductorArgs(
    over: Partial<ConductorRunArgs> = {},
  ): ConductorRunArgs {
    return {
      repo: 'kkef26/nous-agents',
      clauseId: 'NOUS.CONDUCTOR.MERGE_GATES.2',
      dispatchId: 'dispatch-2',
      headSha: '33334444',
      githubToken: 'ghp_faketoken',
      workingDir: WD,
      ...over,
    };
  }

  it('runBuildGate is called AFTER merge and its cwd is args.workingDir', async () => {
    const order: string[] = [];
    const mergeImpl: ConductorRunDeps['mergeImpl'] = async () => {
      order.push('merge');
      return MERGED;
    };
    const buildGateImpl: ConductorRunDeps['buildGateImpl'] = async (a) => {
      order.push('buildGate');
      assert.equal(a.workingDir, WD);
      return {
        status: 'passed',
        tsc: { exit_code: 0, stdout: '', stderr: '' },
        build: { exit_code: 0, stdout: '', stderr: '' },
      };
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl,
      buildGateImpl,
    });
    assert.deepEqual(order, ['merge', 'buildGate']);
    assert.equal(result.status, 'shipped');
  });

  it('runBuildGate is NEVER called if merge did not merge', async () => {
    let buildGateInvoked = 0;
    const mergeImpl: ConductorRunDeps['mergeImpl'] = async () => CONFLICT;
    const buildGateImpl: ConductorRunDeps['buildGateImpl'] = async () => {
      buildGateInvoked++;
      return {
        status: 'passed',
        tsc: { exit_code: 0, stdout: '', stderr: '' },
        build: { exit_code: 0, stdout: '', stderr: '' },
      };
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl,
      buildGateImpl,
    });
    assert.equal(buildGateInvoked, 0);
    assert.equal(result.status, 'not_merged');
    if (result.status === 'not_merged') {
      assert.equal(result.merge.status, 'merge_conflict');
    }
  });

  it('tsc_failed BuildGateResult → conductor status "build_gate_failed", NEVER shipped', async () => {
    const failing: BuildGateResult = {
      status: 'tsc_failed',
      build_output: {
        exit_code: TSC_FAIL.exitCode,
        stdout: TSC_FAIL.stdout,
        stderr: TSC_FAIL.stderr,
      },
    };
    const sink: BuildGateFailureSink & {
      entries: Array<Record<string, unknown>>;
    } = {
      entries: [],
      async writeBuildGateFailure(entry) {
        this.entries.push({ ...entry });
      },
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => failing,
      buildGateFailureSink: sink,
    });
    assert.equal(result.status, 'build_gate_failed');
    assert.notEqual(result.status, 'shipped');
    // conductor_log received the full build_output (constraint 3 downstream)
    assert.equal(sink.entries.length, 1);
    const logged = sink.entries[0]!;
    assert.equal(logged.clause_id, 'NOUS.CONDUCTOR.MERGE_GATES.2');
    assert.equal((logged.build_output as CommandOutput).stdout, TSC_FAIL.stdout);
    assert.equal((logged.build_output as CommandOutput).stderr, TSC_FAIL.stderr);
    assert.equal(
      (logged.build_output as CommandOutput).exit_code,
      TSC_FAIL.exitCode,
    );
  });

  it('build_failed BuildGateResult → conductor status "build_gate_failed", NEVER shipped', async () => {
    const failing: BuildGateResult = {
      status: 'build_failed',
      tsc_output: { exit_code: 0, stdout: '', stderr: '' },
      build_output: {
        exit_code: BUILD_FAIL.exitCode,
        stdout: BUILD_FAIL.stdout,
        stderr: BUILD_FAIL.stderr,
      },
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => failing,
    });
    assert.equal(result.status, 'build_gate_failed');
    assert.notEqual(result.status, 'shipped');
  });

  it('setup_failed BuildGateResult → conductor status "build_gate_failed", NEVER shipped', async () => {
    const failing: BuildGateResult = {
      status: 'setup_failed',
      reason: 'ENOENT node_modules/.bin/tsc',
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => failing,
    });
    assert.equal(result.status, 'build_gate_failed');
    assert.notEqual(result.status, 'shipped');
  });

  it('both phases pass → conductor status "shipped" with merge + buildGate carried through', async () => {
    const passing: BuildGateResult = {
      status: 'passed',
      tsc: { exit_code: 0, stdout: 'tsc ok', stderr: '' },
      build: { exit_code: 0, stdout: 'build ok', stderr: '' },
    };
    const result = await runConductor(baseConductorArgs(), {
      mergeImpl: async () => MERGED,
      buildGateImpl: async () => passing,
    });
    assert.equal(result.status, 'shipped');
    if (result.status === 'shipped') {
      assert.equal(result.merge.status, 'merged');
      assert.equal(result.buildGate.status, 'passed');
    }
  });
});
