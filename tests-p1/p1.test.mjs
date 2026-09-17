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

test('performance adapter enforces latency and concurrency thresholds with metrics', async () => {
  await withTarget(async (baseUrl) => {
    const runtime = new AdapterRuntime().register(createPerformanceAdapter());
    const pass = await runtime.execute('performance', experiment('performance', 'performance'), {
      target: { baseUrl },
      environment: { performance: { path: '/slow', requests: 6, concurrency: 3, maxP95Ms: 250, maxErrorRate: 0 } }
    });
    assert.equal(pass.status, 'pass');
    assert.equal(pass.evidence[0].kind, 'metric');
    assert.equal(pass.evidence[0].payload.concurrency, 3);
    assert.equal(pass.evidence[0].payload.requests, 6);

    const fail = await runtime.execute('performance', experiment('performance', 'performance'), {
      target: { baseUrl },
      environment: { performance: { path: '/slow', requests: 4, concurrency: 2, maxP95Ms: 1, maxErrorRate: 0 } }
    });
    assert.equal(fail.status, 'fail');
    assert.ok(fail.evidence[0].payload.p95Ms > 1);
  });
});

test('MiroFish adapter runs a bounded cohort and ties each observation to run and scenario IDs', async () => {
  const runtime = new AdapterRuntime().register(createMiroFishAdapter({ maxPersonas: 4 }));
  const result = await runtime.execute('customer', experiment('customer', 'customer', 'checkout under payment latency'), {
    target: { name: 'demo-store' },
    environment: {
      runId: 'run-customer-1',
      mirofish: {
        scenarioId: 'checkout-latency',
        personas: ['impatient-mobile', 'careful-desktop', 'repeat-buyer', 'first-time-user'],
        simulatedFailures: ['impatient-mobile']
      }
    }
  });
  assert.equal(result.status, 'fail');
  const observations = result.evidence[0].payload.observations;
  assert.equal(observations.length, 4);
  assert.ok(observations.every((item) => item.runId === 'run-customer-1'));
  assert.ok(observations.every((item) => item.scenarioId === 'checkout-latency'));
  assert.ok(observations.some((item) => item.outcome === 'fail'));
});
