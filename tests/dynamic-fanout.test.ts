import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EphemeralStrandsOrchestrator,
  type AuditPlanningAgent,
} from '../services/orchestrator/strands-orchestrator.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerSession,
} from '../packages/contracts/src/index.js';

const repository = {
  provider: 'github' as const,
  fullName: 'example/repo',
  url: 'https://github.com/example/repo',
  branch: 'main',
  commitSha: 'abc123',
};

function report(brief: AgentWorkerLaunchBrief, overrides: Partial<AgentWorkerReport> = {}): AgentWorkerReport {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: brief.auditId,
    workerId: brief.workerId,
    role: brief.role,
    outcome: 'completed',
    findingState: 'Unknown',
    summary: 'done',
    findings: [],
    evidence: [],
    evidenceRefs: [],
    followUps: [],
    ...overrides,
  };
}

test('A08 worker follow-up request creates a separately queued investigator', async () => {
  const planner: AuditPlanningAgent = {
    async propose() {
      return [{ role: 'security-secrets', objective: 'Inspect auth boundary', mandatory: true }];
    },
  };
  const launchedRoles: string[] = [];
  const launcher: AgentWorkerLauncher = {
    async launch(brief): Promise<AgentWorkerSession> {
      launchedRoles.push(brief.role);
      const result = brief.role === 'security-secrets'
        ? report(brief, {
            findingState: 'Unconfirmed',
            findings: ['Auth callback may trust an unvalidated redirect'],
            evidenceRefs: ['ev:auth'],
            followUps: [{
              role: 'investigator',
              objective: 'Reproduce the redirect behavior independently',
              evidenceRefs: ['ev:auth'],
              reason: 'Initial evidence is suspicious but not sufficient to confirm.',
            }],
          })
        : report(brief);
      return { workerId: brief.workerId, sessionId: brief.workerId, result: Promise.resolve(result), async stop() {} };
    },
    async teardown(session) { await session.stop(); },
  };

  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, {
    maxConcurrency: 2,
    maxRetries: 0,
    workerConstraints: { maxEstimatedSpendUsd: 0.05 },
  });
  const result = await orchestrator.run({
    repository,
    target: null,
    modelProfileId: 'openrouter:test',
    approvedTools: {},
  });

  assert.deepEqual(launchedRoles, ['security-secrets', 'investigator']);
  assert.equal(result.plan.tasks.filter((task) => task.role === 'investigator').length, 1);
  assert.equal(result.outcome, 'completed');
});

test('A08 conflicting isolated reports queue an independent judge', async () => {
  const planner: AuditPlanningAgent = {
    async propose() {
      return [
        { role: 'security-secrets', objective: 'Check claim A', mandatory: true },
        { role: 'api-chaos', objective: 'Check claim A from runtime', mandatory: true },
      ];
    },
  };
  const launchedRoles: string[] = [];
  const launcher: AgentWorkerLauncher = {
    async launch(brief): Promise<AgentWorkerSession> {
      launchedRoles.push(brief.role);
      let result: AgentWorkerReport;
      if (brief.role === 'security-secrets') {
        result = report(brief, { findingState: 'Confirmed', findings: ['Shared claim'], evidenceRefs: ['ev:one'] });
      } else if (brief.role === 'api-chaos') {
        result = report(brief, { findingState: 'Unconfirmed', findings: ['Shared claim'], evidenceRefs: ['ev:two'] });
      } else {
        result = report(brief, { summary: 'Independent adjudication completed' });
      }
      return { workerId: brief.workerId, sessionId: brief.workerId, result: Promise.resolve(result), async stop() {} };
    },
    async teardown(session) { await session.stop(); },
  };
  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, {
    maxConcurrency: 2,
    maxRetries: 0,
    workerConstraints: { maxEstimatedSpendUsd: 0.05 },
  });
  const result = await orchestrator.run({
    repository,
    target: { id: 'target', url: 'http://target.internal', environment: 'shared-observation', immutable: true },
    modelProfileId: 'openrouter:test',
    approvedTools: {},
  });

  assert.ok(launchedRoles.includes('judge'));
  assert.ok(result.plan.tasks.some((task) => task.role === 'judge'));
});
