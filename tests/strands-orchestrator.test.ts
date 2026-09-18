import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EphemeralStrandsOrchestrator,
  type AuditPlanningAgent,
  type PlannedWorker,
} from '../services/orchestrator/strands-orchestrator.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerEventSink,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerSession,
} from '../packages/contracts/src/index.js';

const repo = {
  provider: 'github' as const,
  fullName: 'verifiai/example',
  url: 'https://github.com/verifiai/example',
  branch: 'main',
  commitSha: 'abc123',
};

class FakePlanner implements AuditPlanningAgent {
  calls = 0;
  constructor(private readonly workers: PlannedWorker[]) {}
  async propose() { this.calls += 1; return this.workers; }
}

class FakeLauncher implements AgentWorkerLauncher {
  active = 0;
  peak = 0;
  launches: AgentWorkerLaunchBrief[] = [];
  teardowns: string[] = [];
  failures = new Map<string, number>();

  async launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession> {
    this.launches.push(brief);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await onEvent({ type: 'worker.status', auditId: brief.auditId, workerId: brief.workerId, at: new Date().toISOString(), phase: 'running', message: 'working' });
    const failRemaining = this.failures.get(brief.role) ?? 0;
    if (failRemaining > 0) this.failures.set(brief.role, failRemaining - 1);

    const result = new Promise<AgentWorkerReport>((resolve) => {
      setTimeout(async () => {
        const evidence = { kind: 'test_result' as const, source: 'fake-worker', executed: true, payload: { outcome: 'pass', role: brief.role } };
        await onEvent({ type: 'worker.evidence', auditId: brief.auditId, workerId: brief.workerId, at: new Date().toISOString(), evidence });
        resolve({
          contractVersion: AGENT_WORKER_CONTRACT_VERSION,
          auditId: brief.auditId,
          workerId: brief.workerId,
          role: brief.role,
          outcome: failRemaining > 0 ? 'failed' : 'completed',
          findingState: failRemaining > 0 ? 'Incomplete' : 'Unconfirmed',
          summary: failRemaining > 0 ? 'transient failure' : 'completed',
          findings: [],
          evidence: [],
          evidenceRefs: [`evidence:${brief.workerId}`],
          followUps: [],
        });
      }, 8);
    });

    return {
      workerId: brief.workerId,
      sessionId: `session-${brief.workerId}`,
      result,
      async stop() {},
    };
  }

  async teardown(session: AgentWorkerSession): Promise<void> {
    this.teardowns.push(session.workerId);
    this.active -= 1;
  }
}

test('A03 creates its plan from the planning agent and enforces bounded concurrency', async () => {
  const planner = new FakePlanner([
    { role: 'security-secrets', objective: 'security', mandatory: true },
    { role: 'browser-app-user', objective: 'browser', mandatory: true },
    { role: 'api-chaos', objective: 'api', mandatory: true },
    { role: 'performance-discovery', objective: 'performance', mandatory: true },
  ]);
  const launcher = new FakeLauncher();
  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, { maxConcurrency: 2, maxRetries: 0 });
  const result = await orchestrator.run({
    auditId: 'AUD-A03',
    repository: repo,
    target: { id: 'shared', url: 'http://target', environment: 'shared-observation', immutable: true },
    modelProfileId: 'openrouter:model',
    approvedTools: {
      'security-secrets': [{ name: 'security', capabilities: ['scan'], executionClass: 'agent-native' }],
      'browser-app-user': [{ name: 'browser', capabilities: ['browse'], executionClass: 'agent-native' }],
      'api-chaos': [{ name: 'api', capabilities: ['http'], executionClass: 'deterministic-tool' }],
      'performance-discovery': [{ name: 'performance', capabilities: ['measure'], executionClass: 'deterministic-tool' }],
    },
  });
  assert.equal(planner.calls, 1);
  assert.equal(result.outcome, 'completed');
  assert.ok(result.peakConcurrency <= 2);
  assert.ok(launcher.peak <= 2);
  assert.equal(launcher.launches.length, 4);
  assert.equal(launcher.teardowns.length, 4);
  assert.ok(result.events.some((event) => event.type === 'worker.evidence'));
  assert.ok(result.plan.revision > 1);
});

test('A03 retries only within the configured bound and always tears sessions down', async () => {
  const planner = new FakePlanner([{ role: 'security-secrets', objective: 'security', mandatory: true }]);
  const launcher = new FakeLauncher();
  launcher.failures.set('security-secrets', 1);
  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, { maxConcurrency: 4, maxRetries: 1 });
  const result = await orchestrator.run({
    repository: repo,
    target: null,
    modelProfileId: 'nvidia:model',
    approvedTools: {},
  });
  assert.equal(launcher.launches.length, 2);
  assert.equal(launcher.teardowns.length, 2);
  assert.equal(result.outcome, 'completed');
  assert.equal(result.plan.tasks[0].attempts, 2);
});

test('A03 fails closed when a destructive grant is pointed at the shared target', async () => {
  const planner = new FakePlanner([{ role: 'api-chaos', objective: 'destructive chaos', mandatory: true }]);
  const launcher = new FakeLauncher();
  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, { maxRetries: 0 });
  await orchestrator.run({
    repository: repo,
    target: { id: 'shared', url: 'http://target', environment: 'shared-observation', immutable: true },
    modelProfileId: 'ollama-cloud:model',
    approvedTools: {
      'api-chaos': [{ name: 'chaos', capabilities: ['mutate'], executionClass: 'deterministic-tool', destructive: true }],
    },
  });
  assert.equal(launcher.launches[0].target, null);
  assert.equal(launcher.launches[0].constraints.destructiveAllowed, false);
});

test('A03 orchestrator instances are one-audit ephemeral', async () => {
  const planner = new FakePlanner([{ role: 'security-secrets', objective: 'security', mandatory: true }]);
  const launcher = new FakeLauncher();
  const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, { maxRetries: 0 });
  const input = { repository: repo, target: null, modelProfileId: 'profile', approvedTools: {} };
  await orchestrator.run(input);
  await assert.rejects(() => orchestrator.run(input), /exactly one audit/);
});
