import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuditGuardrailLedger,
  CleanupStack,
  WorkerNetworkPolicy,
  normalizeGuardrails,
} from '../services/orchestrator/guardrails.js';

test('A06 clamps concurrency, retries, time and spend to hackathon-safe bounds', () => {
  const config = normalizeGuardrails({
    maxConcurrentWorkers: 99,
    maxWorkerRetries: 99,
    hardRunSpendUsd: 99,
  });
  assert.equal(config.maxConcurrentWorkers, 4);
  assert.equal(config.maxWorkerRetries, 2);
  assert.equal(config.hardRunSpendUsd, 10);
});

test('A06 spend and concurrency hard stops are enforced before work starts', () => {
  const ledger = new AuditGuardrailLedger(normalizeGuardrails({
    maxConcurrentWorkers: 1,
    hardRunSpendUsd: 0.2,
  }));
  const end = ledger.beginWorker(0.1);
  assert.throws(() => ledger.beginWorker(0), /concurrency limit/);
  end();
  assert.throws(() => ledger.beginWorker(0.11), /spend limit/);
  assert.equal(ledger.snapshot().peakWorkers, 1);
});

test('A06 evidence ceiling refuses oversized artifacts', () => {
  const ledger = new AuditGuardrailLedger(normalizeGuardrails({ maxEvidenceBytes: 64 * 1024 }));
  ledger.recordEvidence({ data: 'x'.repeat(1024) });
  assert.throws(() => ledger.recordEvidence({ data: 'x'.repeat(70 * 1024) }), /evidence size limit/);
});

test('A06 worker URL policy is deny-by-default and refuses wildcard egress', () => {
  assert.throws(() => new WorkerNetworkPolicy(['*']), /unrestricted network/);
  const policy = new WorkerNetworkPolicy(['target.internal', 'integrate.api.nvidia.com']);
  assert.equal(policy.assertUrl('http://target.internal/health').hostname, 'target.internal');
  assert.throws(() => policy.assertUrl('https://example.com'), /not allowlisted/);
});

test('A06 cleanup runs all registered teardown operations in reverse order', async () => {
  const order: string[] = [];
  const stack = new CleanupStack();
  stack.defer('target', async () => { order.push('target'); });
  stack.defer('worker', async () => { order.push('worker'); });
  await stack.run();
  assert.deepEqual(order, ['worker', 'target']);
});
