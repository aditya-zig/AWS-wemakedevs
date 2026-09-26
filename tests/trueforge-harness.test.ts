import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
} from '../packages/contracts/src/index.js';
import { TrueForgeHarnessClient } from '../services/trueforge/client.js';
import { TrueForgeWorkerLauncher } from '../services/trueforge/worker-launcher.js';
import { createTrueForgePlanningAgent } from '../services/orchestrator/trueforge-planner.js';

async function startFakeTrueForge(handler: (req: http.IncomingMessage, body: string) => { status?: number; headers?: Record<string, string>; body?: string }) {
  const server = http.createServer(async (req: any, res: any) => {
    const chunks: any[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const output = handler(req, Buffer.concat(chunks).toString('utf8'));
    res.writeHead(output.status ?? 200, output.headers ?? { 'content-type': 'application/json' });
    res.end(output.body ?? '');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake TrueForge server did not bind');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function sse(events: any[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

test('TrueForge client creates a session and consumes a terminal SSE turn', async () => {
  const fake = await startFakeTrueForge((req) => {
    if (req.method === 'GET' && req.url === '/healthz') return { body: JSON.stringify({ ok: true }) };
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      return { body: JSON.stringify({ data: { id: 'session-1' } }) };
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/session-1/turns') {
      return {
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          { type: 'turn.created', turn: { id: 'turn-1' } },
          { type: 'model.message', content: [{ text: 'intermediate' }] },
          { type: 'turn.done', state: { status: 'done', output: { content: [{ text: '{"ok":true}' }] } } },
        ]),
      };
    }
    return { status: 404, body: JSON.stringify({ error: 'not found' }) };
  });


  const client = new TrueForgeHarnessClient({ baseUrl: fake.baseUrl, timeoutMs: 5_000 });
  await client.health();
  const sessionId = await client.createSession({
    model: { name: 'test/model' },
    instructions: 'test',
  });
  assert.equal(sessionId, 'session-1');
  const result = await client.runTurn(sessionId, 'hello');
  assert.equal(result.status, 'done');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.answer, '{"ok":true}');
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

test('TrueForge planner returns only validated VERIFAI worker roles', async () => {
  const fake = await startFakeTrueForge((req) => {
    if (req.method === 'GET' && req.url === '/healthz') return { body: JSON.stringify({ ok: true }) };
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      return { body: JSON.stringify({ data: { id: 'planner-session' } }) };
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/planner-session/turns') {
      return {
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          {
            type: 'turn.done',
            state: {
              status: 'done',
              output: {
                content: [{
                  text: JSON.stringify({
                    workers: [{ role: 'browser-app-user', objective: 'Exercise the user journey', mandatory: true }],
                  }),
                }],
              },
            },
          },
        ]),
      };
    }
    return { status: 404, body: JSON.stringify({ error: 'not found' }) };
  });


  const { planner, modelProfileId } = await createTrueForgePlanningAgent({
    baseUrl: fake.baseUrl,
    model: 'test/model',
    timeoutMs: 5_000,
  });
  assert.equal(modelProfileId, 'trueforge:test/model');
  const workers = await planner.propose({
    auditId: 'AUD-1',
    repository: {
      provider: 'github',
      fullName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: { id: 'target-1', url: 'http://127.0.0.1:3000', environment: 'shared-observation' },
    objective: 'Find real failures',
    availableRoles: ['browser-app-user', 'performance-discovery'],
  });
  assert.deepEqual(workers, [{ role: 'browser-app-user', objective: 'Exercise the user journey', mandatory: true }]);
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

test('TrueForge worker only keeps Confirmed when executed failing evidence exists', async () => {
  const fake = await startFakeTrueForge((req) => {
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      return { body: JSON.stringify({ data: { id: 'worker-session' } }) };
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/worker-session/turns') {
      return {
        headers: { 'content-type': 'text/event-stream' },
        body: sse([
          {
            type: 'tool.response',
            content: JSON.stringify({
              kind: 'network',
              source: 'test-engine',
              executed: true,
              payload: { outcome: 'fail', status: 500 },
            }),
          },
          {
            type: 'turn.done',
            state: {
              status: 'done',
              output: {
                content: [{
                  text: JSON.stringify({
                    summary: 'Observed a real failing response.',
                    findingState: 'Confirmed',
                    findings: ['Target returned HTTP 500'],
                    followUps: [],
                    verificationDecision: 'fail',
                  }),
                }],
              },
            },
          },
        ]),
      };
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/worker-session/cancel') {
      return { body: JSON.stringify({ ok: true }) };
    }
    return { status: 404, body: JSON.stringify({ error: 'not found' }) };
  });


  const brief: AgentWorkerLaunchBrief = {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: 'AUD-2',
    workerId: 'WORKER-1',
    role: 'browser-app-user',
    objective: 'Check the target',
    repository: {
      provider: 'github',
      fullName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: { id: 'target-1', url: 'http://127.0.0.1:3000', environment: 'shared-observation' },
    tools: [{ name: 'browser', capabilities: ['browser'], executionClass: 'agent-native' }],
    evidenceRefs: [],
    modelProfileId: 'trueforge:test/model',
    constraints: {
      timeoutMs: 5_000,
      maxToolCalls: 4,
      maxEvidenceItems: 10,
      destructiveAllowed: false,
      networkAllowlist: ['127.0.0.1'],
      maxEstimatedSpendUsd: 0.1,
    },
  };

  const events: any[] = [];
  const launcher = new TrueForgeWorkerLauncher({ baseUrl: fake.baseUrl, timeoutMs: 5_000 });
  const session = await launcher.launch(brief, (event) => { events.push(event); });
  const report = await session.result;

  assert.equal(report.outcome, 'completed');
  assert.equal(report.findingState, 'Confirmed');
  assert.equal(report.evidence.length, 1);
  assert.equal(report.evidence[0]?.source, 'test-engine');
  assert.ok(events.some((event) => event.type === 'worker.evidence'));
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});
