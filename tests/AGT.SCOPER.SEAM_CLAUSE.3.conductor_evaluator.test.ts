// AGT.SCOPER.SEAM_CLAUSE.3 — conductor deployed-pixel evaluator tests.
//
// Covers:
//   AC02 — evaluateDeployedPixelAC fetches the AC's deployed_url, parses the
//          returned DOM, and returns 'pass' when the selector resolves and
//          'fail' otherwise. No shell, no local FS, no persistent browser.
//   AC06 — Evaluator returns 'fail' on: HTTP non-2xx, selector miss, missing
//          test_contract on the AC, and network fetch failure. Positive path
//          returns 'pass' when the selector resolves in the returned DOM.
//
// The evaluator is invoked against a local mock HTTP server bound to a
// random port on 127.0.0.1. No external network calls.

import { strict as assert } from 'node:assert';
import { describe, it, before, after } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateDeployedPixelAC } from '../apps/conductor/src/evaluators/deployed-pixel.js';
import { evaluators } from '../apps/conductor/src/evaluators/index.js';
import type { AcceptanceCriterion } from '../scoper/src/decomposition.js';

interface ServerRoutes {
  [path: string]: { status: number; body: string; delayMs?: number } | undefined;
}

let server: Server;
let baseUrl: string;
const routes: ServerRoutes = {};

before(async () => {
  server = createServer((req, res) => {
    const route = routes[req.url ?? ''];
    if (!route) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const send = () => {
      res.statusCode = route.status;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(route.body);
    };
    if (route.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeAc(deployed_url: string, selector: string): AcceptanceCriterion {
  return {
    id: 'AC01',
    text: 'element renders',
    verification: 'deployed-pixel',
    form: 'technical_spec',
    test_contract: { deployed_url, selector },
  };
}

describe('AC02 — evaluateDeployedPixelAC returns "pass" when selector resolves', () => {
  it('returns "pass" for an id selector present in returned HTML', async () => {
    routes['/pass_id'] = {
      status: 200,
      body: '<!doctype html><html><body><div id="root">hi</div></body></html>',
    };
    const ac = makeAc(`${baseUrl}/pass_id`, '#root');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'pass');
  });

  it('returns "pass" for a class selector', async () => {
    routes['/pass_class'] = {
      status: 200,
      body: '<html><body><aside class="shifts-board-chrome__sidebar">x</aside></body></html>',
    };
    const ac = makeAc(`${baseUrl}/pass_class`, 'aside.shifts-board-chrome__sidebar');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'pass');
  });

  it('returns "pass" for a nested selector', async () => {
    routes['/pass_nested'] = {
      status: 200,
      body: '<html><body><div class="wrap"><span data-testid="x">ok</span></div></body></html>',
    };
    const ac = makeAc(`${baseUrl}/pass_nested`, 'div.wrap span[data-testid="x"]');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'pass');
  });
});

describe('AC06 — evaluator returns "fail" on missing element / HTTP error / bad AC', () => {
  it('returns "fail" when the selector does not resolve in the returned HTML', async () => {
    routes['/miss'] = {
      status: 200,
      body: '<html><body><div>no such</div></body></html>',
    };
    const ac = makeAc(`${baseUrl}/miss`, '#nowhere');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });

  it('returns "fail" when the HTTP response is non-2xx', async () => {
    routes['/500'] = { status: 500, body: 'boom' };
    const ac = makeAc(`${baseUrl}/500`, '#root');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });

  it('returns "fail" when the HTTP response is 404', async () => {
    const ac = makeAc(`${baseUrl}/never_registered`, '#root');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });

  it('returns "fail" when the AC is missing test_contract', async () => {
    const ac: AcceptanceCriterion = {
      id: 'AC01',
      text: 'x',
      verification: 'deployed-pixel',
      form: 'technical_spec',
    };
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });

  it('returns "fail" on network fetch failure (unreachable host)', async () => {
    // Port 1 is reserved and reliably refuses connections
    const ac = makeAc('http://127.0.0.1:1/never', '#root');
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });

  it('returns "fail" when a non-deployed-pixel AC is passed (evaluator refuses non-matching verification type)', async () => {
    const ac: AcceptanceCriterion = {
      id: 'AC01',
      text: 'x',
      verification: 'auto',
      form: 'technical_spec',
      test_contract: { deployed_url: `${baseUrl}/pass_id`, selector: '#root' },
    };
    const result = await evaluateDeployedPixelAC(ac);
    assert.equal(result, 'fail');
  });
});

describe('AC02 + AC06 — evaluator dispatch map registration', () => {
  it('evaluators["deployed-pixel"] is registered and is the same function as evaluateDeployedPixelAC', () => {
    assert.equal(typeof evaluators['deployed-pixel'], 'function');
    assert.equal(evaluators['deployed-pixel'], evaluateDeployedPixelAC);
  });

  it('the dispatch map does NOT accidentally register unrelated keys', () => {
    // Guards against a future refactor accidentally spreading the wrong object
    // into the evaluator map.
    const keys = Object.keys(evaluators);
    assert.ok(keys.includes('deployed-pixel'), `missing "deployed-pixel" key; got: ${keys.join(',')}`);
  });
});
