import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  assertAgentWorkerLaunchBrief,
  type AgentWorkerEvent,
  type AgentWorkerEventSink,
  type AgentWorkerLaunchBrief,
  type AgentWorkerReport,
  type EvidenceFindingState,
} from '../../packages/contracts/src/index.js';
import { resolveModelRunSelection, type ModelProviderName } from './providers.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    req.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (block?.type === 'textBlock' && typeof block.text === 'string') return block.text;
    return '';
  }).join('');
}

function parseJson(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('worker model did not return JSON');
}

function selectionFromProfile(profileId: string): { provider: ModelProviderName; modelId: string } {
  const split = profileId.indexOf(':');
  if (split < 1 || split === profileId.length - 1) throw new Error('invalid modelProfileId');
  return { provider: profileId.slice(0, split) as ModelProviderName, modelId: profileId.slice(split + 1) };
}

function findingState(value: unknown): EvidenceFindingState {
  return value === 'Confirmed' || value === 'Unconfirmed' || value === 'Unknown' || value === 'Incomplete' ? value : 'Unknown';
}

function normalizeReport(brief: AgentWorkerLaunchBrief, value: any): AgentWorkerReport {
  const findings = Array.isArray(value?.findings) ? value.findings.filter((item: unknown) => typeof item === 'string').slice(0, 25) : [];
  const summary = typeof value?.summary === 'string' && value.summary.trim() ? value.summary.trim() : 'Worker completed without a summary.';
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: brief.auditId,
    workerId: brief.workerId,
    role: brief.role,
    outcome: 'completed',
    // A lifecycle-only worker has no executed tool evidence yet. It must not claim a confirmed finding.
    findingState: findingState(value?.findingState) === 'Confirmed' ? 'Unknown' : findingState(value?.findingState),
    summary,
    findings,
    evidence: [],
    evidenceRefs: [...brief.evidenceRefs],
    followUps: [],
  };
}

export async function executeAgentCoreWorker(
  brief: AgentWorkerLaunchBrief,
  onEvent: AgentWorkerEventSink = async () => {},
): Promise<AgentWorkerReport> {
  assertAgentWorkerLaunchBrief(brief);
  const { provider, modelId } = selectionFromProfile(brief.modelProfileId);
  const selection = await resolveModelRunSelection({ provider, modelId });
  const model = new OpenAIModel({
    api: 'chat',
    apiKey: selection.credential.reveal(),
    clientConfig: { baseURL: selection.baseUrl },
    modelId: selection.modelId,
  });
  const agent = new Agent({
    model,
    printer: false,
    systemPrompt: [
      `You are the isolated VERIFIAI ${brief.role} worker.`,
      'You are one worker in an audit and cannot talk to peer workers.',
      'Never invent executed evidence or claim Confirmed without executed tool evidence.',
      'At this lifecycle stage, inspect only the structured brief and return a scoped analysis.',
      'Return JSON only: {"summary":"...","findings":["..."],"findingState":"Unknown|Unconfirmed|Incomplete"}.',
    ].join(' '),
  });

  await onEvent({
    type: 'worker.status',
    auditId: brief.auditId,
    workerId: brief.workerId,
    at: new Date().toISOString(),
    phase: 'running',
    message: 'Strands model loop started inside AgentCore runtime',
  });

  const safeBrief = {
    objective: brief.objective,
    role: brief.role,
    repository: brief.repository,
    target: brief.target,
    tools: brief.tools.map((tool) => ({ name: tool.name, capabilities: tool.capabilities, executionClass: tool.executionClass, destructive: tool.destructive === true })),
    evidenceRefs: brief.evidenceRefs,
    constraints: brief.constraints,
  };
  const response = await agent.invoke([
    'Analyze this assigned objective within the supplied scope.',
    'Do not say tools ran unless there is executed evidence in the brief.',
    JSON.stringify(safeBrief),
  ].join('\n'));
  return normalizeReport(brief, parseJson(messageText((response as any).lastMessage)));
}

function writeEnvelope(res: ServerResponse, value: unknown): void {
  res.write(`${JSON.stringify(value)}\n`);
}

export function createAgentCoreWorkerServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'Healthy' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/invocations') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-store');
    let brief: AgentWorkerLaunchBrief | undefined;
    try {
      const body = JSON.parse(await readBody(req));
      if (body?.type !== 'verifiai.worker.launch') throw new Error('unsupported invocation type');
      brief = body.brief;
      assertAgentWorkerLaunchBrief(brief);
      const onEvent: AgentWorkerEventSink = async (event: AgentWorkerEvent) => writeEnvelope(res, { type: 'worker.event', event });
      const report = await executeAgentCoreWorker(brief, onEvent);
      writeEnvelope(res, { type: 'worker.report', report });
    } catch (error: any) {
      const message = String(error?.message ?? error);
      if (brief) {
        writeEnvelope(res, {
          type: 'worker.report',
          report: {
            contractVersion: AGENT_WORKER_CONTRACT_VERSION,
            auditId: brief.auditId,
            workerId: brief.workerId,
            role: brief.role,
            outcome: 'incomplete',
            findingState: 'Incomplete',
            summary: 'AgentCore worker crashed before completing its assignment.',
            findings: [],
            evidence: [],
            evidenceRefs: [...brief.evidenceRefs],
            followUps: [],
            error: message,
          },
        });
      } else {
        writeEnvelope(res, { type: 'error', error: message });
      }
    } finally {
      res.end();
    }
  });
}

if (process.argv[1]?.endsWith('worker-server.js')) {
  const port = Number(process.env.PORT ?? 8080);
  createAgentCoreWorkerServer().listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ service: 'verifiai-agentcore-worker', port, status: 'ready' }));
  });
}
