import test from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalExperimentStatus, summarizeExperimentStatuses, type Experiment } from '../packages/contracts/src/index.js';

test('contract helpers distinguish terminal experiment states and summarize them', () => {
  assert.equal(isTerminalExperimentStatus('pass'), true);
  assert.equal(isTerminalExperimentStatus('fail'), true);
  assert.equal(isTerminalExperimentStatus('unknown'), true);
  assert.equal(isTerminalExperimentStatus('running'), false);

  const experiments: Experiment[] = [
    { id: 'e1', requirementId: 'r1', type: 'browser', tool: 'desktop', description: 'a', status: 'pass', attempts: 1, evidenceIds: [] },
    { id: 'e2', requirementId: 'r1', type: 'api', tool: 'api', description: 'b', status: 'fail', attempts: 1, evidenceIds: [] },
    { id: 'e3', requirementId: 'r2', type: 'security', tool: 'security', description: 'c', status: 'unknown', attempts: 1, evidenceIds: [] },
  ];

  assert.deepEqual(summarizeExperimentStatuses(experiments), { pending: 0, running: 0, pass: 1, fail: 1, unknown: 1 });
});

import type { VerificationTool } from '../packages/contracts/src/index.js';

test('verification tool contract freezes the adapter lifecycle for parallel lanes', async () => {
  const tool: VerificationTool = {
    name: 'api',
    capabilities: ['http'],
    async healthcheck() { return { ok: true }; },
    async prepare() {},
    async execute(experiment) { return { status: 'pass', evidence: [{ kind: 'test_result', source: 'fixture', executed: true, payload: { outcome: 'pass', experimentId: experiment.id } }] }; },
    async stop() {},
    async evidence() { return []; },
    async artifacts() { return []; },
  };
  assert.equal((await tool.healthcheck()).ok, true);
});
