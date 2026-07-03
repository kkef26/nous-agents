/**
 * NOUS.CONDUCTOR.MERGE_GATES.2 — conductor configuration.
 *
 * Adds the buildGate.tscCommand and buildGate.buildCommand config
 * fields with defaults. The build-gate resolver invokes bin against
 * ${workingDir}/node_modules/.bin at runtime (constraint #4 — never
 * hardcode binary paths); config carries only the logical bin name
 * plus its argv, never an absolute filesystem path.
 *
 * DEFAULT_BUILD_GATE_CONFIG.tscCommand runs `tsc --noEmit` — the type
 * check phase mandated by the clause. DEFAULT_BUILD_GATE_CONFIG.
 * buildCommand runs the production bundle (`vite build`), which is
 * the shape the conductor validates before allowing a shipped verdict.
 * Callers may override either command via RunBuildGateArgs.config to
 * suit projects that use alternate toolchains (rollup, tsup, esbuild,
 * a custom npm script bin, etc.).
 */

export interface BuildCommand {
  /** Logical bin name — resolved via node_modules/.bin at runtime. */
  bin: string;
  /** Argv passed to the resolved binary. */
  args: string[];
}

export interface BuildGateConfig {
  tscCommand: BuildCommand;
  buildCommand: BuildCommand;
}

export interface ConductorConfig {
  buildGate: BuildGateConfig;
  smokeGate: SmokeGateConfig;
}

export const DEFAULT_BUILD_GATE_CONFIG: BuildGateConfig = {
  tscCommand: { bin: 'tsc', args: ['--noEmit'] },
  buildCommand: { bin: 'vite', args: ['build'] },
};

// -----------------------------------------------------------------------------
// NOUS.CONDUCTOR.MERGE_GATES.3 — smoke-gate configuration.
//
// Three tunables carried into runSmokeGate:
//   entryRoute       — path appended to http://127.0.0.1:${servePort}
//                      when the headless check mounts the built app
//   servePort        — port the temporary local serve process binds to
//   headlessTimeoutMs — hard cap on the headless mount check; on expiry
//                      the check aborts and runSmokeGate resolves with
//                      SmokeGateResult { reason: 'headless_timeout' }
//
// Each field is independently overridable via a dedicated environment
// variable (constraint AC7). Callers that want the exact literal
// defaults with no env consultation should read DEFAULT_SMOKE_GATE_
// CONFIG; callers that want env-derived config should call
// loadSmokeGateConfig(env).

export interface SmokeGateConfig {
  entryRoute: string;
  servePort: number;
  headlessTimeoutMs: number;
}

export const SMOKE_GATE_ENV_KEYS = {
  entryRoute: 'NOUS_CONDUCTOR_SMOKE_ENTRY_ROUTE',
  servePort: 'NOUS_CONDUCTOR_SMOKE_SERVE_PORT',
  headlessTimeoutMs: 'NOUS_CONDUCTOR_SMOKE_HEADLESS_TIMEOUT_MS',
} as const;

export const DEFAULT_SMOKE_GATE_CONFIG: SmokeGateConfig = {
  entryRoute: '/',
  servePort: 4099,
  headlessTimeoutMs: 15000,
};

/**
 * Build a SmokeGateConfig by layering environment overrides over
 * DEFAULT_SMOKE_GATE_CONFIG. Numeric fields fall back to the default
 * whenever the raw env value fails Number.isFinite (rather than
 * silently producing NaN) — the smoke gate never runs against a
 * malformed port or timeout.
 */
export function loadSmokeGateConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmokeGateConfig {
  const rawPort = env[SMOKE_GATE_ENV_KEYS.servePort];
  const rawTimeout = env[SMOKE_GATE_ENV_KEYS.headlessTimeoutMs];
  const rawRoute = env[SMOKE_GATE_ENV_KEYS.entryRoute];

  const port = rawPort !== undefined && rawPort !== '' ? Number(rawPort) : NaN;
  const timeout =
    rawTimeout !== undefined && rawTimeout !== '' ? Number(rawTimeout) : NaN;

  return {
    entryRoute:
      rawRoute !== undefined && rawRoute !== ''
        ? rawRoute
        : DEFAULT_SMOKE_GATE_CONFIG.entryRoute,
    servePort: Number.isFinite(port)
      ? port
      : DEFAULT_SMOKE_GATE_CONFIG.servePort,
    headlessTimeoutMs: Number.isFinite(timeout)
      ? timeout
      : DEFAULT_SMOKE_GATE_CONFIG.headlessTimeoutMs,
  };
}

export const defaultConductorConfig: ConductorConfig = {
  buildGate: DEFAULT_BUILD_GATE_CONFIG,
  smokeGate: DEFAULT_SMOKE_GATE_CONFIG,
};
