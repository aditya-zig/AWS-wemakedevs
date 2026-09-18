import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
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

test('Deep Audit runs all major engines with failure isolation, nuanced coverage, verified fix, hard guardrails and persistent knowledge', async () => {
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
  assert.ok(run.findings.some((finding) => finding.id === 'FND-CHECKOUT' && finding.state === 'Confirmed'));
  assert.ok(run.findings.some((finding) => finding.id === 'FND-LEAKAGE' && finding.state === 'Confirmed'));
  assert.ok(run.findings.some((finding) => finding.id === 'FND-PERFORMANCE' && finding.state === 'Confirmed'));
  assert.equal(run.fix.status, 'verified');
  assert.equal(run.fix.targeted.passed, 10);
  assert.equal(run.fix.regressionFailures, 0);
  assert.equal(run.fix.pr.ready, true);
  assert.equal(run.fix.pr.autoMerge, false);
  assert.equal(run.fix.proofVideo.redacted, true);
  assert.equal(run.guardrails.withinGuardrails, true);
  assert.ok(run.guardrails.estimatedRunSpendUsd <= run.guardrails.hardRunCapUsd);
  assert.match(run.overall, /limitations|Issues confirmed|Verified/i);
  assert.doesNotMatch(JSON.stringify(run), /do-not-leak-me/);

  const knowledge = new KnowledgeIndex({ filePath: knowledgeFile });
  const facts = await knowledge.query({ repository: 'acme/checkout', commitSha: 'fixture-1' });
  assert.ok(facts.length >= 2);
  assert.ok(facts.every((fact) => fact.revalidationRequired === false));

  const stale = await knowledge.query({ repository: 'acme/checkout', commitSha: 'fixture-2' });
  assert.ok(stale.every((fact) => fact.revalidationRequired === true));

  const steered = await service.steer(run.runId, 'Investigate duplicate-payment risk after late webhook');
  assert.equal(steered.type, 'steering.completed');
  assert.equal(steered.bounded, true);

  const pr = service.createPrPackage(run.runId);
  assert.equal(pr.ready, true);
  assert.equal(pr.autoMerge, false);
  assert.equal(pr.requiresHumanApproval, true);

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
