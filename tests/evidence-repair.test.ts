import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceGraph } from '../packages/core/evidence/index.js';
import { Investigator } from '../packages/core/investigator/index.js';
import { EvidenceJudge } from '../packages/core/judge/index.js';
import { RepairLoop } from '../packages/core/repair/index.js';
import type { Evidence, Experiment } from '../packages/contracts/src/index.js';

const failedExperiment: Experiment = { id: 'exp-pay', requirementId: 'req-pay', type: 'chaos', tool: 'chaos', description: 'inject payment latency', status: 'fail', attempts: 1, evidenceIds: ['ev-fail'] };

const failEvidence: Evidence = {
  id: 'ev-fail', runId: 'run-1', experimentId: 'exp-pay', requirementId: 'req-pay', kind: 'trace', source: 'chaos-runner', capturedAt: '2026-09-17T00:00:00.000Z', executed: true,
  payload: { outcome: 'fail', rootCause: 'frontend timeout path never resets checkout state' }
};

test('judge requires executed evidence and repair loop records before/after verification', async () => {
  const judge = new EvidenceJudge();
  const llmOnly: Evidence = { ...failEvidence, id: 'ev-llm', source: 'llm', executed: false, payload: { outcome: 'pass' } };
  assert.equal(judge.judge('req-pay', [{ ...failedExperiment, status: 'pass', evidenceIds: ['ev-llm'] }], [llmOnly]).verdict, 'UNKNOWN');
  assert.equal(judge.judge('req-pay', [failedExperiment], [failEvidence]).verdict, 'FAILED');

  const investigator = new Investigator();
  const finding = investigator.investigate(failedExperiment, [failEvidence]);
  assert.equal(finding.status, 'confirmed');
  assert.match(finding.rootCause ?? '', /timeout/);

  const graph = new EvidenceGraph();
  graph.linkRequirement('req-pay');
  graph.linkExperiment(failedExperiment);
  graph.addEvidence(failEvidence);
  graph.addFinding(finding);
  assert.ok(graph.edges.some((edge) => edge.type === 'supports'));

  let patched = false;
  const repair = new RepairLoop(judge, {
    async apply() { patched = true; return { branch: 'verifiai/repair-pay', patch: 'reset checkout state in timeout handler' }; }
  }, {
    async rerun() {
      assert.equal(patched, true);
      const passed = { ...failedExperiment, status: 'pass' as const, evidenceIds: ['ev-pass'] };
      const evidence: Evidence[] = [{ ...failEvidence, id: 'ev-pass', source: 'chaos-runner', payload: { outcome: 'pass' } }];
      return { experiments: [passed], evidence };
    }
  });

  const result = await repair.approveAndVerify(finding, [failedExperiment], [failEvidence]);
  assert.equal(result.status, 'verified');
  assert.equal(result.before.verdict, 'FAILED');
  assert.equal(result.after.verdict, 'VERIFIED');
  assert.equal(result.branch, 'verifiai/repair-pay');
});
