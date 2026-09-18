import { randomUUID } from 'node:crypto';
import type {
  AuditRepositoryFacts,
  AuditTargetRef,
} from '../../../packages/contracts/src/index.js';
import { AgentCoreWorkerLauncher } from '../../../services/agent-runtime/agentcore-launcher.js';
import { DockerWorkerLauncher } from '../../../services/agent-runtime/docker-launcher.js';
import { buildSpecialistPolicy } from '../../../services/agents/specialist-policy.js';
import {
  createStrandsPlanningAgent,
  EphemeralStrandsOrchestrator,
  type AuditRunResult,
  type LiveSwarmState,
} from '../../../services/orchestrator/strands-orchestrator.js';

export interface LiveAuditStartInput {
  repository: AuditRepositoryFacts;
  target: AuditTargetRef | null;
  objective?: string;
}

export interface LiveAuditRecord {
  auditId: string;
  mode: 'local' | 'agentcore';
  startedAt: string;
  state: LiveSwarmState;
  result?: AuditRunResult;
  error?: string;
}

export interface LiveAuditServiceOptions {
  env?: Record<string, string | undefined>;
  now?: () => string;
}

interface InternalRecord {
  auditId: string;
  mode: 'local' | 'agentcore';
  startedAt: string;
  orchestrator: EphemeralStrandsOrchestrator;
  result?: AuditRunResult;
  error?: string;
  run: Promise<void>;
}

function executionMode(env: Record<string, string | undefined>): 'local' | 'agentcore' {
  const mode = env.VERIFIAI_EXECUTION_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'agentcore') throw new Error('VERIFIAI_EXECUTION_MODE must be local or agentcore');
  return mode;
}

export class LiveAuditService {
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => string;
  private readonly records = new Map<string, InternalRecord>();

  constructor(options: LiveAuditServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(input: LiveAuditStartInput): Promise<LiveAuditRecord> {
    const mode = executionMode(this.env);
    const { planner, modelProfileId } = await createStrandsPlanningAgent({
      provider: this.env.VERIFIAI_MODEL_PROVIDER as any,
      modelId: this.env.VERIFIAI_MODEL_ID,
      baseUrl: this.env.VERIFIAI_MODEL_BASE_URL,
      awsSecretId: this.env.VERIFIAI_MODEL_SECRET_ID,
      awsSecretField: this.env.VERIFIAI_MODEL_SECRET_FIELD,
    });

    const policy = buildSpecialistPolicy({
      modelProfileId,
      target: input.target,
      computerUseUrl: this.env.VERIFIAI_COMPUTER_USE_URL,
      browserUseUrl: this.env.VERIFIAI_BROWSER_USE_URL,
      cuaUrl: this.env.VERIFIAI_CUA_URL,
      externalEngineUrl: this.env.VERIFIAI_EXTERNAL_ENGINE_URL,
    });

    const launcher = mode === 'local'
      ? new DockerWorkerLauncher({
          image: this.env.VERIFIAI_LOCAL_WORKER_IMAGE,
          cpus: Number(this.env.VERIFIAI_LOCAL_WORKER_CPUS ?? 1),
          memory: this.env.VERIFIAI_LOCAL_WORKER_MEMORY ?? '1024m',
          pidsLimit: Number(this.env.VERIFIAI_LOCAL_WORKER_PIDS ?? 256),
          network: this.env.VERIFIAI_LOCAL_WORKER_NETWORK ?? 'bridge',
          env: this.env,
        })
      : new AgentCoreWorkerLauncher({
          defaultRuntime: {
            region: this.env.AWS_REGION ?? 'us-west-2',
            runtimeArn: this.env.VERIFIAI_AGENTCORE_RUNTIME_ARN ?? '',
          },
        });

    if (mode === 'agentcore' && !this.env.VERIFIAI_AGENTCORE_RUNTIME_ARN) {
      throw new Error('VERIFIAI_AGENTCORE_RUNTIME_ARN is required in agentcore mode');
    }

    const orchestrator = new EphemeralStrandsOrchestrator(planner, launcher, {
      maxConcurrency: Number(this.env.VERIFIAI_MAX_CONCURRENT_WORKERS ?? 4),
      maxRetries: Number(this.env.VERIFIAI_MAX_WORKER_RETRIES ?? 1),
      maxDynamicTasks: Number(this.env.VERIFIAI_MAX_DYNAMIC_WORKERS ?? 12),
      workerConstraints: {
        timeoutMs: Number(this.env.VERIFIAI_WORKER_TIMEOUT_MS ?? 120_000),
        maxToolCalls: Number(this.env.VERIFIAI_MAX_TOOL_CALLS ?? 24),
        maxEvidenceItems: Number(this.env.VERIFIAI_MAX_EVIDENCE_ITEMS ?? 100),
        networkAllowlist: policy.networkAllowlist,
        maxEstimatedSpendUsd: Number(this.env.VERIFIAI_MAX_WORKER_SPEND_USD ?? 0.4),
      },
      guardrails: {
        hardRunSpendUsd: Number(this.env.VERIFIAI_HARD_RUN_SPEND_USD ?? 2.5),
        maxAuditMs: Number(this.env.VERIFIAI_MAX_AUDIT_MS ?? 15 * 60_000),
      },
    });
    const auditId = `AUD-${randomUUID()}`;
    const record: InternalRecord = {
      auditId,
      mode,
      startedAt: this.now(),
      orchestrator,
      run: Promise.resolve(),
    };

    record.run = orchestrator.run({
      auditId,
      repository: input.repository,
      target: input.target,
      modelProfileId,
      approvedTools: policy.approvedTools,
      inapplicable: policy.inapplicable,
      objective: input.objective,
    }).then((result) => {
      record.result = result;
    }).catch((error: any) => {
      record.error = String(error?.message ?? error);
    });

    this.records.set(auditId, record);
    return this.publicRecord(record);
  }

  get(auditId: string): LiveAuditRecord | undefined {
    const record = this.records.get(auditId);
    return record ? this.publicRecord(record) : undefined;
  }

  steer(auditId: string, objective: string): LiveAuditRecord {
    const record = this.records.get(auditId);
    if (!record) throw new Error('audit not found');
    record.orchestrator.steer(objective, { role: 'investigator' });
    return this.publicRecord(record);
  }

  async stop(auditId: string): Promise<LiveAuditRecord> {
    const record = this.records.get(auditId);
    if (!record) throw new Error('audit not found');
    await record.orchestrator.stop('stopped by user');
    await record.run;
    return this.publicRecord(record);
  }

  private publicRecord(record: InternalRecord): LiveAuditRecord {
    return {
      auditId: record.auditId,
      mode: record.mode,
      startedAt: record.startedAt,
      state: record.orchestrator.liveState(),
      result: record.result,
      error: record.error,
    };
  }
}
