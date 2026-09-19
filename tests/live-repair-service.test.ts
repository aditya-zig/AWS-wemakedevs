import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpRegressionRunner } from '../services/agents/repair/repair-flow.js';
import { LiveRepairService } from '../apps/api/repairs/service.js';

test('A09 live repair service reports exact missing real runtime configuration', () => {
  const service = new LiveRepairService({
    env: { VERIFIAI_EXECUTION_MODE: 'agentcore' },
  });
  assert.deepEqual(service.missingConfiguration(true), [
    'VERIFIAI_MUTATION_SERVICE_URL',
    'VERIFIAI_REGRESSION_SERVICE_URL',
    'VERIFIAI_PROOF_RECORDER_URL',
    'VERIFIAI_AGENTCORE_RUNTIME_ARN',
  ]);
});

test('A09 regression runner rejects a passing claim without executed evidence', async () => {
  const runner = new HttpRegressionRunner(
    'https://regression.example.test/run',
    undefined,
    async () => new Response(JSON.stringify({
      passed: true,
      adversarialPassed: true,
      evidence: [],
      evidenceRefs: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  await assert.rejects(
    () => runner.run({
      auditId: 'AUD-1',
      target: { id: 'mut-1', url: 'https://changed.example.test', environment: 'isolated-mutation' },
      source: {
        classification: 'confirmed-defect',
        summary: 'checkout timeout',
        evidenceRefs: ['finding:1'],
        visibleChange: true,
      },
    }),
    /claimed pass without executed evidence/,
  );
});

test('A09 regression runner accepts explicit decisions backed by executed evidence', async () => {
  const runner = new HttpRegressionRunner(
    'https://regression.example.test/run',
    'secret',
    async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer secret');
      return new Response(JSON.stringify({
        passed: true,
        adversarialPassed: true,
        evidence: [{
          kind: 'test_result',
          source: 'real-regression-service',
          executed: true,
          payload: { outcome: 'pass', command: ['npm', 'test'] },
        }],
        evidenceRefs: ['regression:real:1'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  );

  const result = await runner.run({
    auditId: 'AUD-2',
    target: { id: 'mut-2', url: 'https://changed.example.test', environment: 'isolated-mutation' },
    source: {
      classification: 'improvement-opportunity',
      summary: 'clearer onboarding',
      evidenceRefs: ['insight:1'],
      visibleChange: false,
    },
  });
  assert.equal(result.passed, true);
  assert.equal(result.adversarialPassed, true);
  assert.equal(result.evidence[0].executed, true);
});
