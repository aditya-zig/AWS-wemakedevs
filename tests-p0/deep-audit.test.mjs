import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createDemoServer } from '../scripts/serve-web.mjs';
import { BudgetGuard, DeepAuditService, KnowledgeIndex, discoverTarget, redactSecrets } from '../services/deep-audit/index.mjs';

test('repo discovery tries supported bootstrap strategies and reports exact missing inputs', async () => {
  const guard = new BudgetGuard();
  const ready = await discoverTarget({
    repository: 'owner/app',
    commitSha: 'abc123',
    repoFiles: {
      'package.json': JSON.stringify({ scripts: { build: 'vite build', start: 'node server.js' }, dependencies: { vite: '7.0.0' } }),
      'package-lock.json': '{}',
      'README.md': 'staging https://staging.example.com'
    }
  }, { guard, fetchImpl: async () => { throw new Error('network should not be used'); } });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.preferredBootstrap.strategy, 'npm');
  assert.equal(ready.preferredBootstrap.install, 'npm ci');
  assert.equal(ready.deployedUrl, 'https://staging.example.com');

  const missing = await discoverTarget({ repository: 'not-a-github-url' }, {
    guard: new BudgetGuard(),
    fetchImpl: async () => ({ ok: false, text: async () => '' })
  });
  assert.equal(missing.status, 'incomplete');
  assert.ok(missing.missing.some((item) => /manifests unavailable/i.test(item)));
});

test('secret redaction removes explicit and pattern-detected credentials recursively', () => {
  const secret = 'super-private-token';
  const value = redactSecrets({
    authorization: `Bearer ${secret}`,
    nested: { note: `prefix ${secret} suffix`, STRIPE_SECRET: 'sk_test_abcdefghijklmnopqrstuvwxyz' }
  }, [secret]);
  assert.equal(value.authorization, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(value), /super-private-token/);
  assert.doesNotMatch(JSON.stringify(value), /sk_test_abcdefghijklmnopqrstuvwxyz/);
});

test('legacy Deep Audit runs bounded checks without fabricating repair or verification proof', async () => {
  const root = '/tmp/verifiai-deep-audit-test';
  const knowledgeFile = '/tmp/verifiai-deep-audit-knowledge.json';
  await rm(root, { recursive: true, force: true });
  await rm(knowledgeFile, { force: true });

  const service = new DeepAuditService({
    sandboxRoot: root,
    knowledgeFile,
    fetchImpl: async () => { throw new Error('unexpected external network'); }
  });
  const run = await service.run({
    runId: 'deep-test',
    repository: 'acme/checkout',
    commitSha: 'fixture-1',
    credentials: { API_TOKEN: 'do-not-leak-me' },
    guardrails: { maxRunUsd: 1.5, maxHttpRequests: 20, maxConcurrentEngines: 3 }
  });

  assert.equal(run.mode, 'deep-audit');
  assert.equal(run.defaultMode, true);
  for (const name of ['security', 'leakage', 'api', 'browser', 'computer', 'customer', 'chaos', 'performance']) {
    assert.ok(run.engines.some((engine) => engine.name === name), `missing ${name}`);
  }
  assert.ok(run.engines.some((engine) => engine.name === 'deployed'));
  assert.ok(run.engines.some((engine) => engine.name === 'installable'));

  // Legacy deterministic execution must never invent a verified repair.
  assert.equal(run.fix.status, 'not-run');
  assert.equal(run.fix.pr.ready, false);
  assert.equal(run.fix.pr.autoMerge, false);
  assert.equal(run.fix.pr.requiresHumanApproval, true);
  assert.equal(run.fix.proofVideo, null);
  assert.match(
    run.fix.reason,
    /real executed evidence|real swarm|repair gate remains closed/i
  );
  assert.equal(run.guardrails.withinGuardrails, true);
  assert.ok(run.guardrails.estimatedRunSpendUsd <= run.guardrails.hardRunCapUsd);
  assert.match(run.overall, /limitations|Issues confirmed|no confirmed issues/i);
  assert.doesNotMatch(JSON.stringify(run), /do-not-leak-me/);

  const knowledge = new KnowledgeIndex({ filePath: knowledgeFile });
  const facts = await knowledge.query({ repository: 'acme/checkout', commitSha: 'fixture-1' });
  assert.ok(facts.length >= 1);
  assert.ok(facts.every((fact) => fact.revalidationRequired === false));

  const stale = await knowledge.query({ repository: 'acme/checkout', commitSha: 'fixture-2' });
  assert.ok(stale.every((fact) => fact.revalidationRequired === true));

  const steered = await service.steer(run.runId, 'Investigate duplicate-payment risk after late webhook');
  assert.equal(steered.type, 'steering.completed');
  assert.equal(steered.bounded, true);

  // A PR cannot be generated from an unverified legacy repair.
  assert.throws(
    () => service.createPrPackage(run.runId),
    /fix is not verified|PR gate remains closed/i
  );

  await rm(root, { recursive: true, force: true });
  await rm(knowledgeFile, { force: true });
});

test('a tool/runtime limitation is Incomplete without killing the rest of Deep Audit', async () => {
  const service = new DeepAuditService({
    sandboxRoot: '/tmp/verifiai-deep-audit-isolation',
    knowledgeFile: '/tmp/verifiai-deep-audit-isolation-knowledge.json',
    fetchImpl: async () => { throw new Error('simulated network outage'); }
  });
  const run = await service.run({
    runId: 'failure-isolation',
    repository: 'acme/checkout',
    installableApp: 'https://example.invalid/app.apk',
    deployedUrl: 'https://example.invalid'
  });
  const deployed = run.engines.find((engine) => engine.name === 'deployed');
  const installable = run.engines.find((engine) => engine.name === 'installable');
  assert.equal(deployed.state, 'incomplete');
  assert.equal(installable.state, 'incomplete');
  assert.ok(run.engines.some((engine) => engine.name === 'api' && engine.status === 'pass'));
  assert.ok(run.coverage.incomplete >= 2);
  assert.match(run.overall, /limitations/i);
});


test('budget guard hard-stops spend and request overages', () => {
  const cost = new BudgetGuard({ creditCeilingUsd: 100, reserveUsd: 15, maxRunUsd: 0.1, maxHttpRequests: 2 });
  assert.throws(() => cost.charge('customer'), /budget guard blocked/i);
  cost.request(2);
  assert.throws(() => cost.request(1), /request guard blocked/i);
});

test('legacy Deep Audit HTTP path supports audit and steering while keeping unverified PR gate closed', async () => {
  const root = '/tmp/verifiai-deep-audit-http';
  const knowledgeFile = '/tmp/verifiai-deep-audit-http-knowledge.json';
  await rm(root, { recursive: true, force: true });
  await rm(knowledgeFile, { force: true });

  const deepAudit = new DeepAuditService({
    sandboxRoot: root,
    knowledgeFile,
    fetchImpl: async () => { throw new Error('external network disabled in endpoint test'); }
  });
  const server = createDemoServer({ deepAudit });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const auditResponse = await fetch(`${base}/api/demo/deep-audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository: 'acme/checkout', commitSha: 'http-fixture' })
    });
    assert.equal(auditResponse.status, 200);
    const { run } = await auditResponse.json();
    assert.equal(run.defaultMode, true);
    assert.equal(run.fix.status, 'not-run');
    assert.equal(run.fix.pr.ready, false);
    assert.equal(run.fix.proofVideo, null);

    const steerResponse = await fetch(`${base}/api/demo/deep-audit/${encodeURIComponent(run.runId)}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'Investigate duplicate-payment recovery deeper' })
    });

    assert.equal(steerResponse.status, 200);
    const { event } = await steerResponse.json();
    assert.equal(event.type, 'steering.completed');

    const prResponse = await fetch(`${base}/api/demo/deep-audit/${encodeURIComponent(run.runId)}/pr`, { method: 'POST' });
    assert.equal(prResponse.status, 409);
    const prBody = await prResponse.json();
    assert.match(prBody.error, /fix is not verified|PR gate remains closed/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(knowledgeFile, { force: true });
  }
});
