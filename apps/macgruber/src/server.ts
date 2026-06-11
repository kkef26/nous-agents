/**
 * MacGruber API server — the deployed entrypoint (PM2 `macgruber-api`).
 * Binds 127.0.0.1:<MACGRUBER_PORT> and serves /healthz + /intake.
 */

import http from 'node:http';

import { createRequestListener } from './app.js';
import { buildWiring } from './lib/wiring.js';

export const VERSION = 'macgruber-v2.0.0';

function main(): void {
  const wiring = buildWiring();
  const listener = createRequestListener({
    db: wiring.db,
    intakeRoute: { intakeDepsFor: wiring.intakeDepsFor },
    version: VERSION,
  });
  const server = http.createServer((req, res) => {
    void listener(req, res);
  });
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(wiring.env.port, host, () => {
    process.stdout.write(`${VERSION} listening on ${host}:${wiring.env.port}\n`);
  });

  const shutdown = (): void => {
    server.close(() => {
      void wiring.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
