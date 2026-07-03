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
}

export const DEFAULT_BUILD_GATE_CONFIG: BuildGateConfig = {
  tscCommand: { bin: 'tsc', args: ['--noEmit'] },
  buildCommand: { bin: 'vite', args: ['build'] },
};

export const defaultConductorConfig: ConductorConfig = {
  buildGate: DEFAULT_BUILD_GATE_CONFIG,
};
