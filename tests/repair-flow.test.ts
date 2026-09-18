import test from 'node:test';
import assert from 'node:assert/strict';
import { RepairImprovementFlow } from '../services/agents/repair/repair-flow.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerSession,
} from '../packages/contracts/src/index.js';

const repository = {
  provider: 'github' as const,
  fullName: 'example/app',
  url: 'https://github.com/example/app',
  branch: 'main',
  commitSha: 'abc123',
};

function baseReport(brief: AgentWorkerLaunchBrief): AgentWorkerReport {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: brief.auditId,
    workerId: brief.workerId,
    role: brief.role,
    outcome: 'completed',
    findingState: 'Unknown',
    summary: 'complete',
    findings: [],
    evidence: [],
    evidenceRefs: [],
    followUps: [],
  };
}

test('A09 repair is separately reverified, requires real proof video, and never auto-merges', async () => {
  const roles: string[] = [];
  const launcher: AgentWorkerLauncher = {
    async launch(brief): Promise<AgentWorkerSession> {
      roles.push(brief.role);
      const result = baseReport(brief);
      if (brief.role === 'repair') {
        result.evidence = [{
          kind: 'code',
          source: 'mutation-service',
          executed: true,
          payload: {
            outcome: 'pass',
            branch: 'verifiai/fix-a',
            diff: '- bad\n+ good',
            changedFiles: ['src/app.ts'],
          },
        }];
      }
      if (brief.role === 'reverification') result.verificationDecision = 'pass';
      return { workerId: brief.workerId, sessionId: brief.workerId, result: Promise.resolve(result), async stop() {} };
    },
    async teardown(session) { await session.stop(); },
  };

  const flow = new RepairImprovementFlow(
    launcher,
    { async probe() { return { kind: 'runtime', source: 'changed-app-probe', executed: true, payload: { outcome: 'pass' } }; } },
    { async run() { return { passed: true, adversarialPassed: true, evidence: [], evidenceRefs: ['regression:pass'] }; } },
    { async capture() { return { recordingKind: 'real', videoRef: 's3://proof/fix-a.webm', startedAt: 'a', endedAt: 'b', redacted: true }; } },
  );

  const result = await flow.run({
    auditId: 'AUD-A09',
    repository,
    mutableTarget: { id: 'mutation-a', url: 'http://mutation.internal', environment: 'isolated-mutation' },
    modelProfileId: 'openrouter:test',
    networkAllowlist: ['mutation.internal'],
    source: {
      classification: 'confirmed-defect',
      summary: 'Checkout spinner never resets after timeout',
      evidenceRefs: ['finding:checkout-timeout'],
      visibleChange: true,
      baselineUrl: 'http://baseline.internal',
    },
  });

  assert.deepEqual(roles, ['repair', 'reverification']);
  assert.equal(result.status, 'verified');
  assert.equal(result.pr.ready, true);
  assert.equal(result.pr.autoMerge, false);
  assert.equal(result.proofVideo?.recordingKind, 'real');
  assert.equal(result.pr.proofVideoRef, 's3://proof/fix-a.webm');
  assert.notEqual(result.repairReport?.workerId, result.verifierReport?.workerId);
});

test('A09 improvement stays labeled recommendation and is not PR-ready when independent verification is unknown', async () => {
  const launcher: AgentWorkerLauncher = {
    async launch(brief): Promise<AgentWorkerSession> {
      const result = baseReport(brief);
      if (brief.role === 'repair') result.evidence = [{
        kind: 'code',
        source: 'mutation-service',
        executed: true,
        payload: { outcome: 'pass', branch: 'verifiai/improve-a', diff: '+ clearer copy', changedFiles: ['src/copy.ts'] },
      }];
      if (brief.role === 'reverification') result.verificationDecision = 'unknown';
      return { workerId: brief.workerId, sessionId: brief.workerId, result: Promise.resolve(result), async stop() {} };
    },
    async teardown(session) { await session.stop(); },
  };
  const flow = new RepairImprovementFlow(
    launcher,
    { async probe() { return { kind: 'runtime', source: 'changed-app-probe', executed: true, payload: { outcome: 'pass' } }; } },
    { async run() { return { passed: true, adversarialPassed: true, evidence: [], evidenceRefs: [] }; } },
    { async capture() { throw new Error('not needed for invisible change'); } },
  );
  const result = await flow.run({
    auditId: 'AUD-A09-IMPROVE',
    repository,
    mutableTarget: { id: 'mutation-b', url: 'http://mutation.internal', environment: 'isolated-mutation' },
    modelProfileId: 'openrouter:test',
    networkAllowlist: ['mutation.internal'],
    source: {
      classification: 'improvement-opportunity',
      summary: 'Clarify API error copy',
      evidenceRefs: ['insight:error-copy'],
      visibleChange: false,
    },
  });
  assert.equal(result.classificationLabel, 'recommendation');
  assert.equal(result.status, 'incomplete');
  assert.equal(result.pr.ready, false);
  assert.equal(result.pr.autoMerge, false);
});
