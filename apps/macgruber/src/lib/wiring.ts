/**
 * Dependency wiring shared by the API server and the poller entrypoint.
 * One place constructs clients and remediation deps so push and poll paths
 * cannot drift apart.
 */

import { Pool } from 'pg';

import { createDb, registerPoolFactory, type MacgruberDb } from './db.js';
import { loadEnv, type MacgruberEnv } from './env.js';
import { GithubClient } from '../clients/githubClient.js';
import { DispatchClient } from '../clients/dispatchClient.js';
import type { ExecuteActionDeps } from '../executors/executeAction.js';
import type { ProcessIntakeDeps, IntakeEvent } from '../intake/processIntakeEvent.js';
import { attemptResolved, createMechanicalStrategy } from '../strategy/mechanicalStrategy.js';

export const AGENT_ID = 'macgruber';
export const MAX_ATTEMPTS = 2;

export interface Wiring {
  env: MacgruberEnv;
  db: MacgruberDb;
  intakeDepsFor: (event: IntakeEvent) => ProcessIntakeDeps;
  close: () => Promise<void>;
}

export function buildWiring(): Wiring {
  registerPoolFactory(
    (config) =>
      new Pool({
        connectionString: config.connectionString,
        max: config.max ?? 5,
        idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
        application_name: config.applicationName ?? 'macgruber',
      }),
  );
  const env = loadEnv();
  const db = createDb({ connectionString: env.databaseUrl, applicationName: 'macgruber' });
  const github = new GithubClient({ token: env.githubToken, baseUrl: env.githubBaseUrl });
  const dispatch = new DispatchClient({ baseUrl: env.dispatchBaseUrl, apiKey: env.dispatchApiKey });
  const produceFixStrategy = createMechanicalStrategy(db);

  const intakeDepsFor = (event: IntakeEvent): ProcessIntakeDeps => {
    const executor: ExecuteActionDeps = {
      github,
      dispatch,
      db,
      context: {
        github: { token: env.githubToken, baseUrl: env.githubBaseUrl },
        dispatch: { baseUrl: env.dispatchBaseUrl, apiKey: env.dispatchApiKey },
        clauseId: event.clause_id,
        runId: event.dispatch_id,
        project: event.project || env.project,
        recordedBy: AGENT_ID,
      },
    };
    return {
      agent_id: AGENT_ID,
      remediation: {
        executor,
        db,
        maxAttempts: MAX_ATTEMPTS,
        produceFixStrategy,
        attemptResolved,
      },
    };
  };

  return { env, db, intakeDepsFor, close: () => db.close() };
}
