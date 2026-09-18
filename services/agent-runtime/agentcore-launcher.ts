import { randomUUID } from 'node:crypto';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  assertAgentWorkerLaunchBrief,
  type AgentWorkerEvent,
  type AgentWorkerEventSink,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerSession,
} from '../../packages/contracts/src/index.js';

export interface AgentCoreDataClient {
  send(command: unknown): Promise<any>;
}

export interface AgentCoreRuntimeConfig {
  region: string;
  runtimeArn: string;
  qualifier?: string;
}

export interface AgentCoreWorkerLauncherOptions {
  client?: AgentCoreDataClient;
  defaultRuntime?: AgentCoreRuntimeConfig;
  runtimeByRole?: Partial<Record<AgentWorkerLaunchBrief['role'], AgentCoreRuntimeConfig>>;
  now?: () => string;
}

interface RuntimeEnvelopeEvent {
  type: 'worker.event';
  event: AgentWorkerEvent;
}
interface RuntimeEnvelopeReport {
  type: 'worker.report';
  report: AgentWorkerReport;
}
type RuntimeEnvelope = RuntimeEnvelopeEvent | RuntimeEnvelopeReport;

function incompleteReport(brief: AgentWorkerLaunchBrief, summary: string, error?: string): AgentWorkerReport {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: brief.auditId,
    workerId: brief.workerId,
    role: brief.role,
    outcome: 'incomplete',
    findingState: 'Incomplete',
    summary,
    findings: [],
    evidence: [],
    evidenceRefs: [...brief.evidenceRefs],
    followUps: [],
    error,
  };
}

function parseEnvelopeLine(line: string): RuntimeEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const value = JSON.parse(trimmed);
  if (value?.type === 'worker.event' && value.event) return value as RuntimeEnvelopeEvent;
  if (value?.type === 'worker.report' && value.report) return value as RuntimeEnvelopeReport;
  throw new Error('AgentCore worker returned an unknown envelope');
}

function validateEventIdentity(brief: AgentWorkerLaunchBrief, event: AgentWorkerEvent): void {
  if (event.auditId !== brief.auditId || event.workerId !== brief.workerId) {
    throw new Error('AgentCore worker event identity mismatch');
  }
}

function validateReportIdentity(brief: AgentWorkerLaunchBrief, report: AgentWorkerReport): void {
  if (
    report.contractVersion !== AGENT_WORKER_CONTRACT_VERSION ||
    report.auditId !== brief.auditId ||
    report.workerId !== brief.workerId ||
    report.role !== brief.role
  ) {
    throw new Error('AgentCore worker report identity mismatch');
  }
}

async function consumeRuntimeBody(
  body: any,
  onEnvelope: (envelope: RuntimeEnvelope) => Promise<void>,
): Promise<void> {
  if (!body) throw new Error('AgentCore worker returned an empty response body');
  const decoder = new TextDecoder();
  let buffer = '';

  const processBuffer = async (flush = false) => {
    const parts = buffer.split(/\r?\n/);
    buffer = flush ? '' : (parts.pop() ?? '');
    for (const part of parts) {
      const envelope = parseEnvelopeLine(part);
      if (envelope) await onEnvelope(envelope);
    }
    if (flush && buffer.trim()) {
      const envelope = parseEnvelopeLine(buffer);
      buffer = '';
      if (envelope) await onEnvelope(envelope);
    }
  };

  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      await processBuffer(false);
    }
    buffer += decoder.decode();
    const lines = buffer.split(/\r?\n/);
    buffer = '';
    for (const line of lines) {
      const envelope = parseEnvelopeLine(line);
      if (envelope) await onEnvelope(envelope);
    }
    return;
  }

  if (typeof body.transformToString === 'function') {
    const text = await body.transformToString();
    for (const line of String(text).split(/\r?\n/)) {
      const envelope = parseEnvelopeLine(line);
      if (envelope) await onEnvelope(envelope);
    }
    return;
  }

  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  for (const line of text.split(/\r?\n/)) {
    const envelope = parseEnvelopeLine(line);
    if (envelope) await onEnvelope(envelope);
  }
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: any;
  const failure = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, failure]).finally(() => clearTimeout(timer));
}

export class AgentCoreWorkerLauncher implements AgentWorkerLauncher {
  private readonly client: AgentCoreDataClient;
  private readonly now: () => string;
  private readonly stoppedSessions = new Set<string>();

  constructor(private readonly options: AgentCoreWorkerLauncherOptions) {
    const first = options.defaultRuntime ?? Object.values(options.runtimeByRole ?? {})[0];
    const region = first?.region ?? process.env.AWS_REGION ?? 'us-west-2';
    this.client = options.client ?? new BedrockAgentCoreClient({ region });
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private runtimeFor(brief: AgentWorkerLaunchBrief): AgentCoreRuntimeConfig {
    const config = this.options.runtimeByRole?.[brief.role] ?? this.options.defaultRuntime;
    if (!config?.runtimeArn) throw new Error(`No AgentCore runtime configured for role ${brief.role}`);
    return config;
  }

  async launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession> {
    assertAgentWorkerLaunchBrief(brief);
    const runtime = this.runtimeFor(brief);
    const runtimeSessionId = `verifiai-${brief.auditId}-${brief.workerId}-${randomUUID()}`.replace(/[^A-Za-z0-9._:-]/g, '-');
    await onEvent({
      type: 'worker.status',
      auditId: brief.auditId,
      workerId: brief.workerId,
      at: this.now(),
      phase: 'launching',
      message: 'Launching isolated AgentCore worker session',
    });

    let stopRequested = false;
    const stop = async (reason = 'worker session teardown') => {
      if (stopRequested || this.stoppedSessions.has(runtimeSessionId)) return;
      stopRequested = true;
      await onEvent({
        type: 'worker.status',
        auditId: brief.auditId,
        workerId: brief.workerId,
        at: this.now(),
        phase: 'tearing_down',
        message: reason,
      });
      await this.client.send(new StopRuntimeSessionCommand({
        agentRuntimeArn: runtime.runtimeArn,
        runtimeSessionId,
        qualifier: runtime.qualifier ?? 'DEFAULT',
      }));
      this.stoppedSessions.add(runtimeSessionId);
    };

    const result = (async (): Promise<AgentWorkerReport> => {
      try {
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: this.now(),
          phase: 'running',
          message: 'AgentCore worker is running',
        });

        let report: AgentWorkerReport | undefined;
        const invoke = this.client.send(new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtime.runtimeArn,
          runtimeSessionId,
          payload: JSON.stringify({ type: 'verifiai.worker.launch', brief }),
          contentType: 'application/json',
          accept: 'application/x-ndjson',
          qualifier: runtime.qualifier ?? 'DEFAULT',
        })).then(async (response) => {
          await consumeRuntimeBody(response.response, async (envelope) => {
            if (envelope.type === 'worker.event') {
              validateEventIdentity(brief, envelope.event);
              await onEvent(envelope.event);
              return;
            }
            validateReportIdentity(brief, envelope.report);
            report = envelope.report;
          });
        });

        await timeout(invoke, brief.constraints.timeoutMs, `AgentCore worker timed out after ${brief.constraints.timeoutMs}ms`);
        if (!report) throw new Error('AgentCore worker completed without a structured report');
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: this.now(),
          phase: 'reporting',
          message: 'Structured AgentCore worker report received',
        });
        return report;
      } catch (error: any) {
        const message = String(error?.message ?? error);
        try { await stop(message.includes('timed out') ? 'Timeout: stopping AgentCore session' : 'Crash: stopping AgentCore session'); } catch {}
        return incompleteReport(brief, 'AgentCore worker did not complete cleanly', message);
      }
    })();

    return {
      workerId: brief.workerId,
      sessionId: runtimeSessionId,
      result,
      stop,
    };
  }

  async teardown(session: AgentWorkerSession): Promise<void> {
    await session.stop('AgentCore worker session teardown');
  }
}
