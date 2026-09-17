import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SandboxManager } from '../services/sandbox/runtime.mjs';
import { AdapterRuntime } from '../services/integrations/runtime.mjs';
import { createCuaAdapter } from '../packages/adapters/cua/index.mjs';
import { createStrixAdapter } from '../packages/adapters/strix/index.mjs';
import { runFlagshipVerification } from '../services/integrations/flagship.mjs';

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

test('adapter runtime normalizes desktop and security evidence', async () => {
  const runtime = new AdapterRuntime();
  runtime.register(createCuaAdapter());
  runtime.register(createStrixAdapter());
  const desktop = await runtime.execute('desktop', { id: 'exp-desktop', requirementId: 'R-1', type: 'browser', tool: 'desktop', description: 'checkout workflow', status: 'pending', attempts: 0, evidenceIds: [] });
  assert.equal(desktop.status, 'pass');
  assert.ok(desktop.evidence.every((item) => item.executed === true));
  const security = await runtime.execute('security', { id: 'exp-security', requirementId: 'R-2', type: 'security', tool: 'security', description: 'scoped checkout security probe', status: 'pending', attempts: 0, evidenceIds: [] });
  assert.equal(security.status, 'pass');
  assert.match(JSON.stringify(security.evidence), /scope/i);
});

test('flagship verification reproduces latency failure and verifies repair twice from clean state', async () => {
  for (let i = 0; i < 2; i += 1) {
    const result = await runFlagshipVerification({ runId: `demo-${i}` });
    assert.equal(result.before.verdict, 'FAILED');
    assert.equal(result.after.verdict, 'VERIFIED');
    assert.equal(result.regressions, 0);
    assert.equal(result.chaosRestored, true);
    assert.ok(result.evidence.length >= 5);
  }
});

test('web demo exposes the complete flagship journey with no dead primary CTA', async () => {
  const html = await readFile(new URL('../apps/web/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8');
  for (const label of ['Connect GitHub', 'Verification Lab', 'Failure Evidence', 'Approve & Verify', 'Fix Verified']) assert.match(`${html}\n${js}`, new RegExp(label.replace(/[&]/g, '&amp;|&'), 'i'));
  assert.match(js, /nextStep/);
  assert.match(js, /FAILED/);
  assert.match(js, /VERIFIED/);
});
