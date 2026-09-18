import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentCoreWorkerLauncher,
  type AgentCoreDataClient,
} from '../services/agent-runtime/agentcore-launcher.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
} from '../packages/contracts/src/index.js';

function brief(timeoutMs = 500): AgentWorkerLaunchBrief {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: 'AUD-A04',
    workerId: 'W-SEC-A04',
    role: 'security-secrets',
    objective: 'Inspect the launch brief as a real model-backed specialist.',
    repository: {
      provider: 'github',
      fullName: 'verifiai/example',
      url: 'https://github.com/verifiai/example',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: null,
    tools: [{ name: 'security', capabilities: ['scan'], executionClass: 'agent-native' }],
    evidenceRefs: ['evidence:seed'],
    modelProfileId: 'openrouter:test-model',
    constraints: {
      timeoutMs,
      maxToolCalls: 8,
      maxEvidenceItems: 20,
      destructiveAllowed: false,
      networkAllowlist: [],
      maxEstimatedSpendUsd: 0.25,
    },
  };
}

function body(text: string) {
  return { async transformToString() { return text; } };
}

test('A04 launcher maps a structured brief to AgentCore invoke and proves teardown', async () => {
  const commands: any[] = [];
  const client: AgentCoreDataClient = {
    async send(command: any) {
      commands.push(command);
      if (command.constructor.name === 'StopRuntimeSessionCommand') return {};
      const b = brief();
      const event = { type: 'worker.status', auditId: b.auditId, workerId: b.workerId, at: new Date().toISOString(), phase: 'running', message: 'model reasoning' };
      const report = {
        contractVersion: AGENT_WORKER_CONTRACT_VERSION,
        auditId: b.auditId,
        workerId: b.workerId,
        role: b.role,
        outcome: 'completed',
        findingState: 'Unknown',
        summary: 'real worker lifecycle completed',
        findings: [],
        evidence: [],
        evidenceRefs: b.evidenceRefs,
        followUps: [],
      };
      return { response: body(`${JSON.stringify({ type: 'worker.event', event })}\n${JSON.stringify({ type: 'worker.report', report })}\n`) };
    },
  };
  const events: any[] = [];
  const launcher = new AgentCoreWorkerLauncher({
    client,
    defaultRuntime: { region: 'us-west-2', runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/verifiai-worker' },
  });
  const session = await launcher.launch(brief(), async (event) => events.push(event));
  const report = await session.result;
  await launcher.teardown(session);

  assert.equal(report.outcome, 'completed');
  assert.equal(commands.filter((command) => command.constructor.name === 'InvokeAgentRuntimeCommand').length, 1);
  assert.equal(commands.filter((command) => command.constructor.name === 'StopRuntimeSessionCommand').length, 1);
  assert.ok(session.sessionId.length >= 33);
  assert.ok(events.some((event) => event.phase === 'launching'));
  assert.ok(events.some((event) => event.phase === 'reporting'));
  assert.ok(events.some((event) => event.phase === 'tearing_down'));

  const invoke = commands.find((command) => command.constructor.name === 'InvokeAgentRuntimeCommand');
  const payload = JSON.parse(String(invoke.input.payload));
  assert.equal(payload.brief.objective, brief().objective);
  assert.equal(payload.brief.repository.commitSha, 'abc123');
  assert.equal(payload.brief.tools[0].name, 'security');
  assert.deepEqual(payload.brief.evidenceRefs, ['evidence:seed']);
});

test('A04 detects a crashed runtime and returns Incomplete while stopping the session', async () => {
  const commands: any[] = [];
  const launcher = new AgentCoreWorkerLauncher({
    client: {
      async send(command: any) {
        commands.push(command);
        if (command.constructor.name === 'InvokeAgentRuntimeCommand') throw new Error('runtime crashed');
        return {};
      },
    },
    defaultRuntime: { region: 'us-west-2', runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/verifiai-worker' },
  });
  const session = await launcher.launch(brief(), async () => {});
  const report = await session.result;
  assert.equal(report.outcome, 'incomplete');
  assert.equal(report.findingState, 'Incomplete');
  assert.match(report.error ?? '', /runtime crashed/);
  assert.equal(commands.filter((command) => command.constructor.name === 'StopRuntimeSessionCommand').length, 1);
});

test('A04 detects timeout and performs bounded teardown', async () => {
  const commands: any[] = [];
  const launcher = new AgentCoreWorkerLauncher({
    client: {
      async send(command: any) {
        commands.push(command);
        if (command.constructor.name === 'InvokeAgentRuntimeCommand') return new Promise(() => {});
        return {};
      },
    },
    defaultRuntime: { region: 'us-west-2', runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/verifiai-worker' },
  });
  const session = await launcher.launch(brief(20), async () => {});
  const report = await session.result;
  assert.equal(report.outcome, 'incomplete');
  assert.match(report.error ?? '', /timed out/);
  assert.equal(commands.filter((command) => command.constructor.name === 'StopRuntimeSessionCommand').length, 1);
});
