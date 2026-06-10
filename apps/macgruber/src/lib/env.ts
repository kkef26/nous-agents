/**
 * Environment-variable helpers. Fail fast at boot rather than scatter
 * lookups across modules.
 */

export interface MacgruberEnv {
  port: number;
  databaseUrl: string;
  githubToken: string;
  githubBaseUrl: string;
  dispatchBaseUrl: string;
  dispatchApiKey: string;
  project: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): MacgruberEnv {
  return {
    port: parseInt(source.MACGRUBER_PORT ?? '8792', 10),
    databaseUrl: require_(source, 'DATABASE_URL'),
    githubToken: require_(source, 'GITHUB_TOKEN'),
    githubBaseUrl: source.GITHUB_BASE_URL ?? 'https://api.github.com',
    dispatchBaseUrl: require_(source, 'DISPATCH_BASE_URL'),
    dispatchApiKey: require_(source, 'NOUS_API_KEY'),
    project: source.MACGRUBER_PROJECT ?? 'nous-agents',
  };
}

function require_(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}
