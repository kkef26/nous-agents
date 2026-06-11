/**
 * Request listener — zero-dependency HTTP layer over node:http.
 *
 * Routes:
 *   GET  /healthz  → liveness + schema version
 *   POST /intake   → circuit breaker → intake contract → remediation loop
 *
 * The breaker runs BEFORE remediation: a capped (clause, failure_class) pair
 * escalates once to decision_queue and returns 429 so producers' retries
 * cannot thrash the pipeline.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { INTAKE_SCHEMA_VERSION, parseIntakeBody } from './contract/intakeContract.js';
import { createIntakeHandler, type IntakeRouteDeps } from './routes/intake.js';
import {
  checkBreaker,
  insertCapEscalation,
  recordIntake,
  recordOutcome,
} from './persistence/circuitBreaker.js';
import type { ParamQueryClient } from './lib/db.js';

const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppDeps {
  db: ParamQueryClient;
  intakeRoute: IntakeRouteDeps;
  version: string;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

export function createRequestListener(deps: AppDeps) {
  const intakeHandler = createIntakeHandler(deps.intakeRoute);

  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        sendJson(res, 200, {
          status: 'ok',
          version: deps.version,
          intake_schema_version: INTAKE_SCHEMA_VERSION,
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/intake') {
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { error: 'invalid_body', message: (err as Error).message });
          return;
        }

        const parsed = parseIntakeBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { error: parsed.error, failing_fields: parsed.failing_fields });
          return;
        }
        const event = parsed.event;

        const verdict = await checkBreaker(deps.db, event.clause_id, event.failure_class);
        if (!verdict.allowed) {
          const decisionId = await insertCapEscalation(deps.db, {
            clauseId: event.clause_id,
            failureClass: event.failure_class,
            project: event.project,
            reason: verdict.reason as 'per_pair_cap' | 'global_window_cap',
            verdict,
          });
          sendJson(res, 429, {
            error: `circuit_breaker_${verdict.reason}`,
            decision_queue_id: decisionId,
            pair_count: verdict.pair_count,
            global_count: verdict.global_count,
          });
          return;
        }

        const intakeLogId = await recordIntake(deps.db, {
          intake_event_id: event.intake_event_id,
          dispatch_id: event.dispatch_id,
          clause_id: event.clause_id,
          project: event.project,
          failure_class: event.failure_class,
          source: event.source,
        });

        let statusCode = 200;
        let payload: unknown = null;
        const shim = {
          status(code: number) {
            statusCode = code;
            return shim;
          },
          json(p: unknown) {
            payload = p;
          },
        };
        await intakeHandler({ body }, shim);

        if (intakeLogId) {
          const p = payload as {
            ok?: boolean;
            outcome?: { resolved?: boolean; escalated?: boolean; decision_id?: string | null };
          } | null;
          const outcome = !p?.ok
            ? 'error'
            : p.outcome?.resolved
              ? 'resolved'
              : p.outcome?.escalated
                ? 'escalated'
                : 'unresolved';
          await recordOutcome(deps.db, intakeLogId, outcome, p?.outcome?.decision_id ?? null).catch(
            (err: unknown) => {
              process.stderr.write(`[macgruber] outcome record failed: ${(err as Error).message}\n`);
            },
          );
        }
        sendJson(res, statusCode, payload);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[macgruber] unhandled listener error: ${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', message });
    }
  };
}
