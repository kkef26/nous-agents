import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { notifyMacGruber } from '../src/macgruberClient.js';

const BASE_PAYLOAD = {
  failure_class: 'integration_error',
  error_message: 'scoper mode B held: missing AC',
  step_attempted: 'prerequisites_check',
  repo: 'kkef26/nous-agents',
  branch: 'main',
  sha: 'abc1234',
  clause_id: 'EX.1',
  prior_attempts: 0,
  dispatch_event_id: '00000000-0000-0000-0000-000000000002',
  agent_id: 'scoper-test',
  timestamp: '2026-06-10T00:00:00.000Z',
};

describe('scoper notifyMacGruber', () => {
  it('skips push when MACGRUBER_INTAKE_URL is unset', async () => {
    const original = process.env.MACGRUBER_INTAKE_URL;
    delete process.env.MACGRUBER_INTAKE_URL;
    try {
      const result = await notifyMacGruber(BASE_PAYLOAD, { logger: () => {} });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? '', /MACGRUBER_INTAKE_URL/);
    } finally {
      if (original !== undefined) process.env.MACGRUBER_INTAKE_URL = original;
    }
  });

  it('graceful on non-2xx', async () => {
    process.env.MACGRUBER_INTAKE_URL = 'http://localhost:0/intake';
    const fakeFetch: typeof fetch = async () => new Response('nope', { status: 500 });
    const result = await notifyMacGruber(BASE_PAYLOAD, {
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'http_500');
  });

  it('delivers on 2xx for both Mode B and Mode C contexts', async () => {
    process.env.MACGRUBER_INTAKE_URL = 'http://localhost:0/intake';
    let lastBody: string = '';
    const fakeFetch: typeof fetch = async (_url, init) => {
      lastBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'x', status: 'pending' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const result = await notifyMacGruber(BASE_PAYLOAD, {
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(result.delivered, true);
    const parsed = JSON.parse(lastBody) as { reported_by: string };
    assert.equal(parsed.reported_by, 'scoper');
  });
});
