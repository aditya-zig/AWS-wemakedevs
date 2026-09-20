import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
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

export interface LocalProcessWorkerLauncherOptions {
  entrypoint?: string;
  cwd?: string;
  now?: () => string;
  env?: Record<string, string | undefined>;
}

type WorkerEnvelope =
  | { type: 'worker.event'; event: AgentWorkerEvent }
  | { type: 'worker.report'; report: AgentWorkerReport };

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

function parseEnvelope(line: string): WorkerEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const value = JSON.parse(trimmed);
  if (value?.type === 'worker.event' && value.event) return value;
  if (value?.type === 'worker.report' && value.report) return value;
  throw new Error('Local process worker returned an unknown envelope');
}

export class LocalProcessWorkerLauncher implements AgentWorkerLauncher {
  private readonly now: () => string;
  private readonly entrypoint: string;
  private readonly cwd: string;
  private readonly env: Record<string, string | undefined>;
  private readonly processes = new Map<string, any>();

  constructor(options: LocalProcessWorkerLauncherOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.entrypoint = options.entrypoint ?? join(process.cwd(), 'dist/services/agent-runtime/worker-cli.js');
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
  }

  async launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession> {
    assertAgentWorkerLaunchBrief(brief);
    await onEvent({
      type: 'worker.status',
      auditId: brief.auditId,
      workerId: brief.workerId,
      at: this.now(),
      phase: 'launching',
      message: 'Launching the real Strands worker as a local process',
    });

    const child = spawn(process.execPath, [this.entrypoint], {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const processId = `${brief.auditId}-${brief.workerId}`;
    this.processes.set(processId, child);

    let stopped = false;
    let report: AgentWorkerReport | undefined;
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });

    const stop = async (reason = 'Local Strands worker teardown') => {
      if (stopped) return;
      stopped = true;
      await onEvent({
        type: 'worker.status',
        auditId: brief.auditId,
        workerId: brief.workerId,
        at: this.now(),
        phase: 'tearing_down',
        message: reason,
      });
      if (!child.killed) child.kill('SIGTERM');
      this.processes.delete(processId);
    };

    const result = (async (): Promise<AgentWorkerReport> => {
      const lines = createInterface({ input: child.stdout });
      const consume = (async () => {
        for await (const line of lines) {
          const envelope = parseEnvelope(line);
          if (!envelope) continue;
          if (envelope.type === 'worker.event') {
            if (envelope.event.auditId !== brief.auditId || envelope.event.workerId !== brief.workerId) {
              throw new Error('Local process worker event identity mismatch');
            }
            await onEvent(envelope.event);
          } else {
            if (
              envelope.report.contractVersion !== AGENT_WORKER_CONTRACT_VERSION ||
              envelope.report.auditId !== brief.auditId ||
              envelope.report.workerId !== brief.workerId ||
              envelope.report.role !== brief.role
            ) throw new Error('Local process worker report identity mismatch');
            report = envelope.report;
          }
        }
      })();

      const exited = new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', (code: number | null) => resolveExit(code ?? 1));
      });
      child.stdin.end(JSON.stringify({ type: 'verifiai.worker.launch', brief }));

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Local Strands worker timed out after ${brief.constraints.timeoutMs}ms`)), brief.constraints.timeoutMs);
      });

      try {
        const code = await Promise.race([exited, timeout]);
        if (timer) clearTimeout(timer);
        await consume;
        if (code !== 0) throw new Error(`Local Strands worker exited with code ${code}: ${stderr.trim()}`);
        if (!report) throw new Error('Local Strands worker completed without a structured report');
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: this.now(),
          phase: 'reporting',
          message: 'Structured real Strands worker report received',
        });
        return report;
      } catch (error: any) {
        if (timer) clearTimeout(timer);
        await stop(String(error?.message ?? error).includes('timed out') ? 'Timeout: stopping local Strands worker' : 'Failure: stopping local Strands worker');
        return incompleteReport(brief, 'Local Strands worker did not complete cleanly', String(error?.message ?? error));
      } finally {
        this.processes.delete(processId);
      }
    })();

    return { workerId: brief.workerId, sessionId: processId, result, stop };
  }

  async teardown(session: AgentWorkerSession): Promise<void> {
    await session.stop('Local Strands worker teardown');
  }
}
