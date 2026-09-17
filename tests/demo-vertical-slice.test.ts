import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirements, buildVerificationPlan } from '../packages/core/planning/index.js';
import { VerificationOrchestrator } from '../packages/core/orchestrator/index.js';
import { EvidenceJudge } from '../packages/core/judge/index.js';
import { Investigator } from '../packages/core/investigator/index.js';
import { RepairLoop } from '../packages/core/repair/index.js';
import type { Evidence, Experiment, ToolName } from '../packages/contracts/src/index.js';

test('demo slice proves payment failure, confirms root cause, repairs and reverifies', async () => {
  const requirements = parseRequirements([
    'If the payment provider becomes unavailable, checkout must fail gracefully and preserve the user cart.',
    'The health API should respond successfully.',
    'Expired authentication must not allow protected actions.',
  ]);
  const plan = buildVerificationPlan(requirements);
  const paymentRequirement = requirements[0];

  const runners = new Map<ToolName, any>([
    ['api', async () => ({ status: 'pass', evidence: [{ kind: 'test_result', source: 'api-runner', executed: true, payload: { outcome: 'pass', status: 200 } }] })],
    ['desktop', async () => ({ status: 'pass', evidence: [{ kind: 'screenshot', source: 'desktop-runner', executed: true, payload: { outcome: 'pass', screenshot: 'checkout.png' } }] })],
    ['security', async () => ({ status: 'pass', evidence: [{ kind: 'test_result', source: 'security-runner', executed: true, payload: { outcome: 'pass' } }] })],
    ['chaos', async () => ({ status: 'fail', evidence: [{ kind: 'trace', source: 'chaos-runner', executed: true, payload: { outcome: 'fail', latencyMs: 8000, reproduced: '3/3', rootCause: 'frontend timeout path never resets checkout state' } }] })],
  ]);
  const run = await new VerificationOrchestrator(runners).execute('shop', plan);
  const judge = new EvidenceJudge();
  const before = judge.judge(paymentRequirement.id, run.experiments, run.evidence);
  assert.equal(before.verdict, 'FAILED');

  const failed = run.experiments.find((experiment) => experiment.requirementId === paymentRequirement.id && experiment.status === 'fail');
  assert.ok(failed);
  const finding = new Investigator().investigate(failed!, run.evidence);
  assert.equal(finding.status, 'confirmed');
  assert.match(finding.rootCause ?? '', /timeout/);

  const repair = new RepairLoop(judge, {
    async apply() { return { branch: 'verifiai/repair-checkout-timeout', patch: 'reset checkout state when provider timeout occurs' }; }
  }, {
    async rerun(experiments) {
      const fixedExperiments: Experiment[] = experiments.map((experiment, i) => ({ ...experiment, status: 'pass', evidenceIds: [`fixed-${i}`] }));
      const fixedEvidence: Evidence[] = fixedExperiments.map((experiment, i) => ({
        id: `fixed-${i}`, runId: 'run-fixed', experimentId: experiment.id, requirementId: experiment.requirementId,
        kind: 'test_result', source: experiment.tool, capturedAt: '2026-09-17T00:00:00.000Z', executed: true,
        payload: { outcome: 'pass', regressionFailures: 0, chaosPassed: true },
      }));
      return { experiments: fixedExperiments, evidence: fixedEvidence };
    }
  });
  const result = await repair.approveAndVerify(finding, run.experiments, run.evidence);
  assert.equal(result.before.verdict, 'FAILED');
  assert.equal(result.after.verdict, 'VERIFIED');
  assert.equal(result.status, 'verified');
});
