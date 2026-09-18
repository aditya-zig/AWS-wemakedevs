import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
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

const execFileAsync = promisify(execFile);

export interface DockerWorkerLauncherOptions {
  image?: string;
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  network?: string;
  dockerBinary?: string;
  now?: () => string;
  env?: Record<string, string | undefined>;
}

export interface DockerRunSpec {
  containerName: string;
  args: string[];
  forwardedEnvNames: string[];
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
}

function providerEnvName(modelProfileId: string): string {
  const provider = modelProfileId.split(':', 1)[0];
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  if (provider === 'nvidia') return 'NVIDIA_API_KEY';
  if (provider === 'ollama-cloud') return 'OLLAMA_API_KEY';
  throw new Error(`Unsupported local model provider: ${provider}`);
}

export function buildDockerRunSpec(
  brief: AgentWorkerLaunchBrief,
  options: DockerWorkerLauncherOptions = {},
): DockerRunSpec {
  assertAgentWorkerLaunchBrief(brief);
  const env = options.env ?? process.env;
  const image = options.image ?? env.VERIFIAI_LOCAL_WORKER_IMAGE ?? 'verifiai-agent-worker:local';
  const cpus = Math.max(0.1, Math.min(options.cpus ?? Number(env.VERIFIAI_LOCAL_WORKER_CPUS ?? 1), 8));
  const memory = options.memory ?? env.VERIFIAI_LOCAL_WORKER_MEMORY ?? '1024m';
  const pidsLimit = Math.max(32, Math.min(options.pidsLimit ?? Number(env.VERIFIAI_LOCAL_WORKER_PIDS ?? 256), 2048));
  const network = options.network ?? env.VERIFIAI_LOCAL_WORKER_NETWORK ?? 'bridge';
  const credentialEnv = providerEnvName(brief.modelProfileId);

  if (!env[credentialEnv] && !env.VERIFIAI_MODEL_SECRET_ID) {
    throw new Error(`Local Docker worker requires ${credentialEnv} or VERIFIAI_MODEL_SECRET_ID`);
  }

  const forwarded = new Set<string>([
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'VERIFIAI_MODEL_SECRET_ID',
    'VERIFIAI_MODEL_SECRET_FIELD',
    'VERIFIAI_EXTERNAL_ENGINE_URL',
    'VERIFIAI_EXTERNAL_ENGINE_TOKEN',
    'VERIFIAI_COMPUTER_USE_URL',
    'VERIFIAI_COMPUTER_USE_TOKEN',
    'VERIFIAI_MUTATION_SERVICE_URL',
    'VERIFIAI_MUTATION_SERVICE_TOKEN',
    credentialEnv,
  ]);
  for (const name of [...forwarded]) if (!env[name]) forwarded.delete(name);

  const containerName = safeName(`verifiai-${brief.auditId}-${brief.workerId}`);
  const args = [
    'run',
    '--rm',
    '--name', containerName,
    '--cpus', String(cpus),
    '--memory', memory,
    '--pids-limit', String(pidsLimit),
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--network', network,
    '--label', `verifiai.audit=${brief.auditId}`,
    '--label', `verifiai.worker=${brief.workerId}`,
  ];
  for (const name of forwarded) args.push('-e', name);
  args.push('-i', image, 'node', 'dist/services/agent-runtime/worker-cli.js');

  return { containerName, args, forwardedEnvNames: [...forwarded] };
}

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

function parseEnvelope(line: string): { type: 'worker.event'; event: AgentWorkerEvent } | { type: 'worker.report'; report: AgentWorkerReport } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const value = JSON.parse(trimmed);
  if (value?.type === 'worker.event' && value.event) return value;
  if (value?.type === 'worker.report' && value.report) return value;
  throw new Error('Local Docker worker returned an unknown envelope');
}

export class DockerWorkerLauncher implements AgentWorkerLauncher {
  private readonly now: () => string;
  private readonly dockerBinary: string;
  private readonly env: Record<string, string | undefined>;
  private readonly processes = new Map<string, any>();

  constructor(private readonly options: DockerWorkerLauncherOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.dockerBinary = options.dockerBinary ?? 'docker';
    this.env = options.env ?? process.env;
  }

  async launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession> {
    const spec = buildDockerRunSpec(brief, { ...this.options, env: this.env });
    await onEvent({
      type: 'worker.status',
      auditId: brief.auditId,
      workerId: brief.workerId,
      at: this.now(),
      phase: 'launching',
      message: 'Launching resource-limited local Docker worker',
    });

    const child = spawn(this.dockerBinary, spec.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.processes.set(spec.containerName, child);

    let stopped = false;
    let report: AgentWorkerReport | undefined;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-12_000); });

    const stop = async (reason = 'local Docker worker teardown') => {
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
      try { await execFileAsync(this.dockerBinary, ['rm', '-f', spec.containerName], { env: this.env }); } catch {}
      if (!child.killed) child.kill('SIGTERM');
      this.processes.delete(spec.containerName);
    };

    const result = (async (): Promise<AgentWorkerReport> => {
      const lines = createInterface({ input: child.stdout });
      const consume = (async () => {
        for await (const line of lines) {
          const envelope = parseEnvelope(line);
          if (!envelope) continue;
          if (envelope.type === 'worker.event') {
            if (envelope.event.auditId !== brief.auditId || envelope.event.workerId !== brief.workerId) {
              throw new Error('Local Docker worker event identity mismatch');
            }
            await onEvent(envelope.event);
          } else {
            if (
              envelope.report.contractVersion !== AGENT_WORKER_CONTRACT_VERSION ||
              envelope.report.auditId !== brief.auditId ||
              envelope.report.workerId !== brief.workerId ||
              envelope.report.role !== brief.role
            ) throw new Error('Local Docker worker report identity mismatch');
            report = envelope.report;
          }
        }
      })();

      const exited = new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code: number | null) => resolve(code ?? 1));
      });

      child.stdin.end(JSON.stringify({ type: 'verifiai.worker.launch', brief }));

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Local Docker worker timed out after ${brief.constraints.timeoutMs}ms`)), brief.constraints.timeoutMs);
      });

      try {
        const code = await Promise.race([exited, timeout]);
        if (timer) clearTimeout(timer);
        await consume;
        if (code !== 0) throw new Error(`Local Docker worker exited with code ${code}: ${stderr.trim()}`);
        if (!report) throw new Error('Local Docker worker completed without a structured report');
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: this.now(),
          phase: 'reporting',
          message: 'Structured local Docker worker report received',
        });
        return report;
      } catch (error: any) {
        if (timer) clearTimeout(timer);
        await stop(String(error?.message ?? error).includes('timed out') ? 'Timeout: stopping local Docker worker' : 'Failure: stopping local Docker worker');
        return incompleteReport(brief, 'Local Docker worker did not complete cleanly', String(error?.message ?? error));
      } finally {
        this.processes.delete(spec.containerName);
      }
    })();

    return {
      workerId: brief.workerId,
      sessionId: spec.containerName,
      result,
      stop,
    };
  }

  async teardown(session: AgentWorkerSession): Promise<void> {
    await session.stop('Local Docker worker teardown');
  }
}
