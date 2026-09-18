import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  AGENT_WORKER_LIFECYCLE,
  assertAgentWorkerLaunchBrief,
  validateAgentWorkerLaunchBrief,
  isTerminalExperimentStatus,
  summarizeExperimentStatuses,
  type AgentWorkerLaunchBrief,
  type Experiment,
  type VerificationTool,
} from '../packages/contracts/src/index.js';

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

test('verification tool contract freezes the deterministic tool lifecycle', async () => {
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

test('real worker contract freezes one launch → evidence/report → teardown boundary', () => {
  assert.deepEqual(AGENT_WORKER_LIFECYCLE, ['queued','launching','running','reporting','tearing_down','completed']);
  const brief: AgentWorkerLaunchBrief = {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: 'AUD-1',
    workerId: 'W-SEC-1',
    role: 'security-secrets',
    objective: 'Inspect auth and secret exposure using executed evidence only.',
    repository: {
      provider: 'github',
      fullName: 'example/shop',
      url: 'https://github.com/example/shop',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: { id: 'target-1', url: 'http://target.internal', environment: 'shared-observation', immutable: true },
    tools: [{ name: 'strix', capabilities: ['security'], executionClass: 'agent-native' }],
    evidenceRefs: [],
    modelProfileId: 'demo',
    constraints: {
      timeoutMs: 120000,
      maxToolCalls: 24,
      maxEvidenceItems: 100,
      destructiveAllowed: false,
      networkAllowlist: ['target.internal'],
      maxEstimatedSpendUsd: 0.5,
    },
  };
  assert.deepEqual(validateAgentWorkerLaunchBrief(brief), []);
  assert.doesNotThrow(() => assertAgentWorkerLaunchBrief(brief));
});

test('invalid worker briefs fail closed', () => {
  const errors = validateAgentWorkerLaunchBrief({
    contractVersion: 'old',
    auditId: '',
    workerId: '',
    role: 'fake-agent',
    objective: '',
    modelProfileId: '',
    tools: 'not-an-array',
    evidenceRefs: [],
    constraints: { timeoutMs: 0, maxToolCalls: 0, maxEvidenceItems: 0, destructiveAllowed: 'yes', networkAllowlist: 'all' },
  });
  assert.ok(errors.length >= 8);
  assert.throws(() => assertAgentWorkerLaunchBrief({}), /Invalid agent worker launch brief/);
});
