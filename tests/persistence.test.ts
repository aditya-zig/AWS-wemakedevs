import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph, JsonEvidenceGraphStore } from '../packages/core/evidence/index.js';
import type { Evidence, Experiment } from '../packages/contracts/src/index.js';

const experiment: Experiment = { id: 'exp-1', requirementId: 'req-1', type: 'api', tool: 'api', description: 'health', status: 'pass', attempts: 1, evidenceIds: ['ev-1'] };
const evidence: Evidence = { id: 'ev-1', runId: 'run-1', experimentId: 'exp-1', requirementId: 'req-1', kind: 'test_result', source: 'api', capturedAt: '2026-09-17T00:00:00.000Z', executed: true, payload: { outcome: 'pass' } };

test('evidence graph persists and reloads nodes and edges', async () => {
  const path = `/tmp/verifiai-evidence-${Date.now()}-${Math.random()}.json`;
  const graph = new EvidenceGraph();
  graph.linkRequirement('req-1');
  graph.linkExperiment(experiment);
  graph.addEvidence(evidence);

  const store = new JsonEvidenceGraphStore(path);
  await store.save(graph);
  const restored = await store.load();

  assert.deepEqual(restored.nodes, graph.nodes);
  assert.deepEqual(restored.edges, graph.edges);
});
