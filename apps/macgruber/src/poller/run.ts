/**
 * Poller entrypoint (PM2 `macgruber-poller`, cron-restarted).
 * Catches failures the push path missed, routes them through the SAME
 * processIntakeEvent wiring as /intake, then exits.
 */

import { buildWiring } from '../lib/wiring.js';
import { pollMissedFailures } from './pollMissedFailures.js';

async function main(): Promise<void> {
  const wiring = buildWiring();
  const summary = await pollMissedFailures({
    db: wiring.db,
    intakeDepsFor: wiring.intakeDepsFor,
    options: {
      lookbackMinutes: parseInt(process.env.MACGRUBER_POLLER_LOOKBACK_MINUTES ?? '60', 10),
      limit: parseInt(process.env.MACGRUBER_POLLER_LIMIT ?? '50', 10),
    },
    log: (m) => process.stdout.write(`${m}\n`),
  });
  await wiring.close();
  process.exit(summary.exitCode);
}

main().catch((err: unknown) => {
  process.stderr.write(`[macgruber-poller] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
