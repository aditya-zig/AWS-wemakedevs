import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AdapterRuntime } from '../services/integrations/runtime.mjs';
import { createApiAdapter } from '../packages/adapters/api/index.mjs';
import { createPerformanceAdapter } from '../packages/adapters/performance/index.mjs';
import { createMiroFishAdapter } from '../packages/adapters/mirofish/index.mjs';

async function withTarget(fn) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/slow') await new Promise((resolve) => setTimeout(resolve, 25));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try { await fn(baseUrl); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const experiment = (tool, type, description = 'verification') => ({
  id: `exp-${tool}`,
  requirementId: `req-${tool}`,
  type,
  tool,
  description,
  status: 'pending',
  attempts: 0,
  evidenceIds: []
});

test('API adapter produces pass and fail evidence for HTTP invariants', async () => {
  await withTarget(async (baseUrl) => {
    const runtime = new AdapterRuntime().register(createApiAdapter());
    const pass = await runtime.execute('api', experiment('api', 'api'), {
      target: { baseUrl },
      environment: { api: { path: '/health', expectedStatus: 200, expectedJson: { ok: true } } }
    });
    assert.equal(pass.status, 'pass');
    assert.equal(pass.evidence[0].executed, true);
    assert.equal(pass.evidence[0].payload.status, 200);

    const fail = await runtime.execute('api', experiment('api', 'api'), {
      target: { baseUrl },
      environment: { api: { path: '/health', expectedStatus: 503, expectedJson: { ok: true } } }
    });
    assert.equal(fail.status, 'fail');
    assert.equal(fail.evidence[0].payload.expectedStatus, 503);
  });
});

test('performance adapter declares real Locust/k6 execution rather than an in-process load-test clone', () => {
  const locust = createPerformanceAdapter({ engine: 'locust' });
  const k6 = createPerformanceAdapter({ engine: 'k6' });
  assert.ok(locust.capabilities.includes('locust'));
  assert.ok(locust.capabilities.includes('real-load-test'));
  assert.ok(k6.capabilities.includes('k6'));
  assert.ok(k6.capabilities.includes('real-load-test'));
});

test('MiroFish adapter reports unknown when the real service is not configured', async () => {
  const runtime = new AdapterRuntime().register(createMiroFishAdapter({ baseUrl: '' }));
  const result = await runtime.execute('customer', experiment('customer', 'customer', 'simulate customer behavior'), {
    target: { baseUrl: 'http://target.local' },
    environment: { mirofish: { seedText: 'Product context long enough for a real MiroFish seed document.' } }
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.evidence, []);
});

