import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { SandboxManager } from '../services/sandbox/runtime.mjs';
import { AdapterRuntime } from '../services/integrations/runtime.mjs';
import { createCuaAdapter } from '../packages/adapters/cua/index.mjs';
import { createStrixAdapter } from '../packages/adapters/strix/index.mjs';
import { runFlagshipVerification } from '../services/integrations/flagship.mjs';
import { createDemoServer } from '../scripts/serve-web.mjs';

test('sandbox creates clean isolated runs and cleanup removes them', async () => {
  const manager = new SandboxManager({ root: '/tmp/verifiai-p0-sandbox-test' });
  await manager.reset();
  const first = await manager.create('run-a');
  const second = await manager.create('run-b');
  assert.notEqual(first.path, second.path);
  assert.deepEqual(await manager.listFiles('run-a'), []);
  assert.deepEqual(await manager.listFiles('run-b'), []);
  await manager.writeArtifact('run-a', 'proof.json', '{"ok":true}');
  assert.deepEqual(await manager.listFiles('run-b'), []);
  await manager.destroy('run-a');
  assert.equal(await manager.exists('run-a'), false);
  await manager.reset();
});

test('named external adapters never substitute fake evidence when runtimes are absent', async () => {
  const runtime = new AdapterRuntime();
  runtime.register(createCuaAdapter({ serviceUrl: '' }));
  runtime.register(createStrixAdapter({ command: '__verifiai_missing_strix__' }));
  const desktop = await runtime.execute('desktop', { id: 'exp-desktop', requirementId: 'R-1', type: 'browser', tool: 'desktop', description: 'checkout workflow', status: 'pending', attempts: 0, evidenceIds: [] });
  assert.equal(desktop.status, 'unknown');
  assert.deepEqual(desktop.evidence, []);
  const security = await runtime.execute('security', { id: 'exp-security', requirementId: 'R-2', type: 'security', tool: 'security', description: 'scoped checkout security probe', status: 'pending', attempts: 0, evidenceIds: [] });
  assert.equal(security.status, 'unknown');
  assert.deepEqual(security.evidence, []);
});

test('legacy flagship helper refuses to fabricate proof without a real target', async () => {
  const result = await runFlagshipVerification({ runId: 'legacy-truth-test', targetUrl: '' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.overall, 'Incomplete');
  assert.deepEqual(result.evidence, []);
  assert.match(result.reason, /real Strands swarm|target/i);
});

test('public site exposes the complete Deep Audit story with live audit CTAs', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  for (const label of ['Audit your repo', 'Deep Audit', 'Live evidence', 'Evidence, not AI guesses', 'Create pull request']) {
    assert.match(`${html}\n${js}`, new RegExp(label, 'i'));
  }
  assert.match(html, /data-audit-trigger/);
  assert.match(js, /openDrawer/);
  assert.match(js, /runFlagshipAudit/);
  assert.match(js, /\/api\/audits/);
  assert.match(js, /fetchSwarm/);
  assert.match(js, /applySwarm/);
  assert.match(html, /deployedUrlInput/);
  assert.match(html, /installableAppInput/);
  assert.match(html, /tempTokenInput/);
  assert.match(js, /runResult/);
  assert.match(js, /Confirmed/);
  assert.match(js, /Incomplete/);
  assert.match(js, /verified/);
});

test('fabricated flagship HTTP endpoint is removed from the public server', async () => {
  const server = createDemoServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/demo/flagship`, { method: 'POST' });
    assert.equal(response.status, 405);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('target runtime redacts secrets and returns structured healthy startup evidence', async () => {
  const { TargetRuntime } = await import('../services/sandbox/target.mjs');
  const runtime = new TargetRuntime();
  const secret = 'demo-super-secret';
  const build = await runtime.build({ command: `node -e "console.log(process.env.API_SECRET)"`, env: { API_SECRET: secret } });
  assert.equal(build.ok, true);
  assert.doesNotMatch(`${build.stdout}${build.stderr}`, new RegExp(secret));
  assert.match(build.stdout, /REDACTED/);
  const port = 19000 + Math.floor(Math.random() * 1000);
  const started = await runtime.start({ command: `node -e "require('http').createServer((q,r)=>{r.end('ok')}).listen(${port})"`, env: { API_SECRET: secret } });
  assert.equal(started.ok, true);
  const health = await runtime.healthcheck(`http://127.0.0.1:${port}`, { timeoutMs: 3000 });
  assert.equal(health.ok, true);
  await runtime.stop();
});

test('observability sink stores structured evidence and raw artifacts by run', async () => {
  const { EvidenceSink } = await import('../packages/observability/index.mjs');
  const sink = new EvidenceSink({ root: '/tmp/verifiai-observability-test' });
  await sink.reset();
  const entry = await sink.record('run-observe', 'exp-1', { kind: 'runtime', source: 'sandbox', executed: true, payload: { status: 'healthy' } });
  assert.equal(entry.runId, 'run-observe');
  const artifact = await sink.writeArtifact('run-observe', 'stdout.log', 'healthy\n');
  assert.match(artifact, /stdout\.log$/);
  const entries = await sink.list('run-observe');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.status, 'healthy');
  await sink.reset();
});
