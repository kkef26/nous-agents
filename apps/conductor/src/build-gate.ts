/**
 * NOUS.CONDUCTOR.MERGE_GATES.2 — post-merge two-phase build gate.
 *
 * The 2026-07-03 whole-tree-break design decision (Kosta grill):
 *     "Full-build gate on the POST-MERGE tree: tsc --noEmit AND
 *      production build must exit 0 on the merged whole before a
 *      clause flips to shipped. Per-worker test greenness is NOT
 *      sufficient."
 *
 * runBuildGate is the independently importable named export that
 * carries out that gate. It:
 *
 *   1. Runs the configured tsc command (default: tsc --noEmit) inside
 *      the post-merge staging checkout (args.workingDir). Constraint
 *      #1 — this working directory is the only tree the gate ever
 *      inspects; callers must NOT pass any other path.
 *   2. If tsc exits non-zero, returns { status: 'tsc_failed',
 *      build_output: { exit_code, stdout, stderr } } and does NOT run
 *      the build phase. Both stdout AND stderr are preserved verbatim
 *      (constraint #3 — never discard either stream).
 *   3. Otherwise runs the configured build command (default:
 *      vite build) in the same working directory.
 *   4. If build exits non-zero, returns { status: 'build_failed',
 *      tsc_output, build_output } with both streams preserved.
 *   5. If both exit 0, returns { status: 'passed', tsc, build }.
 *   6. If binary resolution against ${workingDir}/node_modules/.bin
 *      fails for either command, returns { status: 'setup_failed',
 *      reason } WITHOUT running any command — the gate never guesses
 *      at a global path (constraint #4).
 *
 * runBuildGate is deliberately NOT inlined into the conductor
 * orchestrator body (constraint #5) so callers can drive it in
 * isolation from tests and future orchestrators.
 */

import type {
  BuildGateResult,
  CommandOutput,
} from './types.js';
import {
  DEFAULT_BUILD_GATE_CONFIG,
  type BuildCommand,
  type BuildGateConfig,
} from './config.js';

export interface RunBuildGateArgs {
  /**
   * The post-merge staging checkout. Every spawn issued by the gate
   * uses this as cwd — constraint #1 forbids running against any
   * other tree state.
   */
  workingDir: string;
  /** Optional override for the tsc / build commands. Defaults to DEFAULT_BUILD_GATE_CONFIG. */
  config?: BuildGateConfig;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type BinaryResolver = (
  bin: string,
  workingDir: string,
) => Promise<string>;

export interface RunBuildGateDeps {
  /** Executes a command and resolves with the captured streams. */
  spawnImpl?: (
    bin: string,
    args: string[],
    opts: { cwd: string },
  ) => Promise<SpawnResult>;
  /** Resolves a logical bin name to an absolute filesystem path. */
  resolveBinaryImpl?: BinaryResolver;
}

export async function runBuildGate(
  args: RunBuildGateArgs,
  deps: RunBuildGateDeps = {},
): Promise<BuildGateResult> {
  const config = args.config ?? DEFAULT_BUILD_GATE_CONFIG;
  const spawn = deps.spawnImpl ?? defaultSpawn;
  const resolve = deps.resolveBinaryImpl ?? defaultResolveBinary;

  let tscPath: string;
  let buildPath: string;
  try {
    tscPath = await resolve(config.tscCommand.bin, args.workingDir);
    buildPath = await resolve(config.buildCommand.bin, args.workingDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'setup_failed', reason: message };
  }

  const tsc = await runCommand(spawn, tscPath, config.tscCommand.args, args.workingDir);
  if (tsc.exit_code !== 0) {
    return { status: 'tsc_failed', build_output: tsc };
  }

  const build = await runCommand(
    spawn,
    buildPath,
    config.buildCommand.args,
    args.workingDir,
  );
  if (build.exit_code !== 0) {
    return {
      status: 'build_failed',
      tsc_output: tsc,
      build_output: build,
    };
  }

  return { status: 'passed', tsc, build };
}

async function runCommand(
  spawn: NonNullable<RunBuildGateDeps['spawnImpl']>,
  bin: string,
  argv: string[],
  cwd: string,
): Promise<CommandOutput> {
  const result = await spawn(bin, argv, { cwd });
  return {
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// -----------------------------------------------------------------------------
// default spawn + resolver — used when callers don't inject deps.
// Kept minimal; the interesting invariants are covered by the injected
// implementations under test.

const defaultSpawn: NonNullable<RunBuildGateDeps['spawnImpl']> = async (
  bin,
  argv,
  opts,
) => {
  const { spawn } = await import('node:child_process');
  return new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(bin, argv, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', rejectPromise);
    proc.on('close', (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
};

const defaultResolveBinary: BinaryResolver = async (bin, workingDir) => {
  const { access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(workingDir, 'node_modules', '.bin', bin);
  await access(path);
  return path;
};

/** Exposed for tests and callers that share the same resolver logic. */
export { defaultSpawn, defaultResolveBinary };

/** Re-exported for convenience; canonical types live in ./types.js and ./config.js. */
export type { BuildCommand, BuildGateConfig };
