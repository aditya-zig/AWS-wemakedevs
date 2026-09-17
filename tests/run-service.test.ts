import test from 'node:test';
import assert from 'node:assert/strict';
import { RunService } from '../apps/api/runs/service.js';
import { VerificationOrchestrator } from '../packages/core/orchestrator/index.js';
import type { Experiment, ToolName } from '../packages/contracts/src/index.js';

const experiments: Experiment[] = [
  { id: 'e1', requirementId: 'r1', type: 'api', tool: 'api', description: 'api', status: 'pending', attempts: 0, evidenceIds: [] },
  { id: 'e2', requirementId: 'r1', type: 'chaos', tool: 'chaos', description: 'chaos', status: 'pending', attempts: 0, evidenceIds: [] },
];

test('run service retains completed runs and exposes ordered events', async () => {
  const runners = new Map<ToolName, any>([
    ['api', async () => ({ status: 'pass', evidence: [{ kind: 'test_result', source: 'api', executed: true, payload: { outcome: 'pass' } }] })],
    ['chaos', async () => { throw new Error('offline'); }],
  ]);
  const service = new RunService(new VerificationOrchestrator(runners));
  const run = await service.start('p1', experiments);

  assert.equal(service.get(run.id)?.id, run.id);
  assert.equal(service.events(run.id).at(-1)?.type, 'run.completed');
  assert.equal(run.experiments[1].status, 'unknown');
});
