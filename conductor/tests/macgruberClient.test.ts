import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { notifyMacGruber } from '../src/macgruberClient.js';

const BASE_PAYLOAD = {
  failure_class: 'test_failure',
  error_message: 'unit test failed',
  step_attempted: 'npm test',
  repo: 'kkef26/nous-agents',
  branch: 'dispatch/EX.1',
  sha: 'abc1234',
  clause_id: 'EX.1',
  prior_attempts: 1,
  dispatch_event_id: '00000000-0000-0000-0000-000000000001',
  agent_id: 'conductor-test',
  timestamp: '2026-06-10T00:00:00.000Z',
};

describe('conductor notifyMacGruber', () => {
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

  it('reports non-2xx without throwing', async () => {
    process.env.MACGRUBER_INTAKE_URL = 'http://localhost:0/intake';
    const fakeFetch: typeof fetch = async () =>
      new Response('boom', { status: 503 });
    const result = await notifyMacGruber(BASE_PAYLOAD, {
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'http_503');
  });

  it('reports delivered on 2xx', async () => {
    process.env.MACGRUBER_INTAKE_URL = 'http://localhost:0/intake';
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ id: 'x', status: 'pending' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    const result = await notifyMacGruber(BASE_PAYLOAD, {
      fetchImpl: fakeFetch,
      logger: () => {},
    });
    assert.equal(result.delivered, true);
  });
});
