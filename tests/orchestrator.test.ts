import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationOrchestrator } from '../packages/core/orchestrator/index.js';
import type { Experiment, ToolName } from '../packages/contracts/src/index.js';

const experiments: Experiment[] = [
  { id: 'e1', requirementId: 'r1', type: 'api', tool: 'api', description: 'api', status: 'pending', attempts: 0, evidenceIds: [] },
  { id: 'e2', requirementId: 'r1', type: 'chaos', tool: 'chaos', description: 'chaos', status: 'pending', attempts: 0, evidenceIds: [] },
  { id: 'e3', requirementId: 'r2', type: 'browser', tool: 'desktop', description: 'browser', status: 'pending', attempts: 0, evidenceIds: [] },
];

test('run continues after one tool failure and records a complete state plus events', async () => {
  const events: string[] = [];
  const runners = new Map<ToolName, any>([
    ['api', async () => ({ status: 'pass', observations: ['200 OK'], evidence: [{ kind: 'test_result', source: 'api-runner', payload: { status: 200 }, executed: true }] })],
    ['chaos', async () => { throw new Error('adapter unavailable'); }],
    ['desktop', async () => ({ status: 'fail', observations: ['spinner never ended'], evidence: [{ kind: 'screenshot', source: 'desktop-runner', payload: { screenshot: 'checkout.png' }, executed: true }] })],
  ]);
  const orchestrator = new VerificationOrchestrator(runners);
  orchestrator.onEvent((event) => events.push(event.type));
  const run = await orchestrator.execute('project-1', experiments);

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.counts, { pending: 0, running: 0, pass: 1, fail: 1, unknown: 1 });
  assert.equal(run.experiments[1].status, 'unknown');
  assert.ok(events.includes('experiment.started'));
  assert.ok(events.includes('experiment.unknown'));
  assert.ok(events.includes('run.completed'));
  assert.equal(run.evidence.length, 3);
});

import type { VerificationTool } from '../packages/contracts/src/index.js';

test('orchestrator consumes the frozen verification-tool contract without third-party internals', async () => {
  const tool: VerificationTool = {
    name: 'api', capabilities: ['http'],
    async healthcheck() { return { ok: true }; },
    async prepare() {},
    async execute() { return { status: 'pass', evidence: [{ kind: 'test_result', source: 'adapter', executed: true, payload: { outcome: 'pass' } }] }; },
    async stop() {}, async evidence() { return []; }, async artifacts() { return []; },
  };
  const orchestrator = VerificationOrchestrator.fromTools([tool]);
  const run = await orchestrator.execute('p1', [experiments[0]]);
  assert.equal(run.experiments[0].status, 'pass');
});
