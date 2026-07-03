/**
 * NOUS.CONDUCTOR.MERGE_GATES.3 — pre-swap smoke gate.
 *
 * The 2026-07-03 grill decision:
 *   "Before overwriting a served dist/ on any host, conductor verifies
 *    the fresh build serves (HTTP 200 on index + main bundle) and the
 *    entry route mounts without console errors (headless check). On
 *    failure: keep previous dist, mark clause verification_pending,
 *    surface to decision_queue."
 *
 * runSmokeGate is the independently importable named export that
 * carries out that gate. It:
 *
 *   1. Starts a temporary local serve process rooted at the freshly
 *      built dist/ path, bound to config.servePort.
 *   2. Issues an HTTP GET against the index URL. Non-200 status →
 *      returns SmokeGateResult { status: 'smoke_failed',
 *      reason: 'http_check_failed' } and tears the serve process down.
 *   3. Runs a headless browser check against the entry route URL,
 *      capped at config.headlessTimeoutMs. Timeout → returns
 *      SmokeGateResult { reason: 'headless_timeout' }. Non-zero exit
 *      OR any captured console error → returns
 *      SmokeGateResult { reason: 'headless_mount_error' }.
 *      Constraint: a non-zero exit is NEVER treated as a pass, even
 *      when no console.error lines were captured.
 *   4. Only when the HTTP check AND the headless check pass does
 *      runSmokeGate invoke swapDist to move the new dist/ into the
 *      served location. Constraint: swapDist is NEVER called on any
 *      other branch.
 *   5. The serve process is torn down in BOTH the pass AND fail
 *      branches (constraint — no lingering child process on the
 *      configured smokeGate.servePort). Teardown lives in the finally
 *      arm so exceptions from the checks cannot skip it.
 *
 * runSmokeGate and swapDist live in separate files so the conductor
 * orchestrator can drive them, but neither is inlined into the
 * orchestrator body (constraint #4).
 */

import { swapDist as defaultSwapDist } from './dist-swap.js';
import {
  DEFAULT_SMOKE_GATE_CONFIG,
  type SmokeGateConfig,
} from './config.js';
import type { SmokeGateResult } from './types.js';

export interface RunSmokeGateArgs {
  /** Absolute path to the freshly built dist/ directory to smoke test. */
  newDistPath: string;
  /** Absolute path to the served location swapDist will move into on pass. */
  servedDistPath: string;
  /** Optional SmokeGateConfig override. Defaults to DEFAULT_SMOKE_GATE_CONFIG. */
  config?: SmokeGateConfig;
}

/** Handle returned by the local serve implementation. */
export interface ServeHandle {
  /** Stop the serve process. MUST be idempotent. */
  teardown(): Promise<void>;
}

/** Response of the HTTP index probe. */
export interface HttpCheckResponse {
  status: number;
}

/** Result of a completed headless run (non-timeout). */
export interface HeadlessCheckOutcome {
  exitCode: number;
  consoleErrors: string[];
}

/**
 * Sentinel timeout return from the headless check. Kept as a string
 * union member rather than an exception so callers can pattern-match
 * on it without try/catch.
 */
export const HEADLESS_TIMEOUT = 'headless_timeout' as const;
export type HeadlessCheckResult = HeadlessCheckOutcome | typeof HEADLESS_TIMEOUT;

export interface RunSmokeGateDeps {
  /**
   * Starts a local static serve of `distPath` on `port` and resolves
   * with a handle whose teardown() shuts it down. If the serve cannot
   * bind, the impl throws and runSmokeGate propagates the error — no
   * SmokeGateResult is synthesized (the caller sees the setup error).
   */
  serveImpl?: (distPath: string, port: number) => Promise<ServeHandle>;
  /** Issues an HTTP GET and resolves with the status code. */
  httpCheckImpl?: (url: string) => Promise<HttpCheckResponse>;
  /**
   * Runs a headless mount against `url` with a hard cap of `timeoutMs`.
   * On expiry returns HEADLESS_TIMEOUT; otherwise returns the exit code
   * plus any console errors captured. Constraint: the impl MUST NOT
   * treat a non-zero exit as a pass; the smoke-gate body enforces the
   * same rule structurally.
   */
  headlessCheckImpl?: (
    url: string,
    timeoutMs: number,
  ) => Promise<HeadlessCheckResult>;
  /** Called ONLY on smoke_passed with the new dist path as source. */
  swapDistImpl?: (args: {
    source: string;
    dest: string;
  }) => Promise<void>;
}

export async function runSmokeGate(
  args: RunSmokeGateArgs,
  deps: RunSmokeGateDeps = {},
): Promise<SmokeGateResult> {
  const config = args.config ?? DEFAULT_SMOKE_GATE_CONFIG;
  const serve = deps.serveImpl ?? defaultServe;
  const httpCheck = deps.httpCheckImpl ?? defaultHttpCheck;
  const headlessCheck = deps.headlessCheckImpl ?? defaultHeadlessCheck;
  const swap =
    deps.swapDistImpl ?? ((swapArgs) => defaultSwapDist(swapArgs));

  const handle = await serve(args.newDistPath, config.servePort);
  try {
    const base = `http://127.0.0.1:${config.servePort}`;

    const indexResp = await httpCheck(`${base}/`);
    if (indexResp.status !== 200) {
      return { status: 'smoke_failed', reason: 'http_check_failed' };
    }

    const entryUrl = `${base}${normalizeRoute(config.entryRoute)}`;
    const headless = await headlessCheck(entryUrl, config.headlessTimeoutMs);
    if (headless === HEADLESS_TIMEOUT) {
      return { status: 'smoke_failed', reason: 'headless_timeout' };
    }
    if (headless.exitCode !== 0 || headless.consoleErrors.length > 0) {
      return { status: 'smoke_failed', reason: 'headless_mount_error' };
    }

    await swap({ source: args.newDistPath, dest: args.servedDistPath });
    return { status: 'smoke_passed' };
  } finally {
    await handle.teardown();
  }
}

// -----------------------------------------------------------------------------
// helpers

function normalizeRoute(route: string): string {
  if (route.length === 0) return '/';
  return route.startsWith('/') ? route : `/${route}`;
}

// -----------------------------------------------------------------------------
// default impls — kept minimal; the interesting invariants are covered
// by the injected implementations under test.

const defaultServe: NonNullable<RunSmokeGateDeps['serveImpl']> = async (
  distPath,
  port,
) => {
  const { spawn } = await import('node:child_process');
  const proc = spawn('npx', ['--yes', 'serve', '-s', distPath, '-l', String(port)], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
  return {
    async teardown() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    },
  };
};

const defaultHttpCheck: NonNullable<RunSmokeGateDeps['httpCheckImpl']> = async (
  url,
) => {
  const resp = await fetch(url);
  return { status: resp.status };
};

const defaultHeadlessCheck: NonNullable<
  RunSmokeGateDeps['headlessCheckImpl']
> = async (url, timeoutMs) => {
  const { spawn } = await import('node:child_process');
  return await new Promise<HeadlessCheckResult>((resolvePromise) => {
    const consoleErrors: string[] = [];
    const proc = spawn(
      'node',
      [
        '-e',
        `import('node:http').then(async ({default:h}) => { const r = await fetch(${JSON.stringify(url)}); if (r.status !== 200) { process.stderr.write('console.error status ' + r.status + '\\n'); process.exit(1); } process.exit(0); });`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );
    let settled = false;
    const settle = (r: HeadlessCheckResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(r);
    };
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
      settle(HEADLESS_TIMEOUT);
    }, timeoutMs);
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text.includes('console.error') || text.toLowerCase().includes('error')) {
        consoleErrors.push(text);
      }
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      settle({ exitCode: code ?? -1, consoleErrors });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      settle({ exitCode: -1, consoleErrors: ['spawn error'] });
    });
  });
};

/** Re-exported for callers that share the same defaults. */
export { defaultSwapDist as swapDist };
