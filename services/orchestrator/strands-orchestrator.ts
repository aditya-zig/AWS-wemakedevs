import { randomUUID } from 'node:crypto';
import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentToolGrant,
  type AgentWorkerConstraints,
  type AgentWorkerEvent,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerRole,
  type AgentWorkerSession,
  type AuditRepositoryFacts,
  type AuditTargetRef,
  type EvidenceInput,
} from '../../packages/contracts/src/index.js';
import { resolveModelRunSelection, type ModelRunSelectionInput } from '../agent-runtime/providers.js';
import {
  AuditGuardrailLedger,
  normalizeGuardrails,
  type AuditGuardrailConfig,
  type AuditGuardrailSnapshot,
} from './guardrails.js';

export type AuditTaskState = 'queued' | 'launching' | 'running' | 'retrying' | 'completed' | 'skipped' | 'incomplete' | 'failed';

export interface AuditPlanTask {
  id: string;
  role: AgentWorkerRole;
  objective: string;
  mandatory: boolean;
  state: AuditTaskState;
  attempts: number;
  evidenceRefs: string[];
  report?: AgentWorkerReport;
  lastError?: string;
  skipReason?: string;
}

export interface LivingAuditPlan {
  auditId: string;
  revision: number;
  tasks: AuditPlanTask[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditRunInput {
  auditId?: string;
  repository: AuditRepositoryFacts;
  target: AuditTargetRef | null;
  modelProfileId: string;
  approvedTools: Partial<Record<AgentWorkerRole, AgentToolGrant[]>>;
  inapplicable?: Partial<Record<AgentWorkerRole, string>>;
  objective?: string;
}

export interface AuditRunResult {
  auditId: string;
  outcome: 'completed' | 'incomplete' | 'failed';
  plan: LivingAuditPlan;
  reports: AgentWorkerReport[];
  evidence: EvidenceInput[];
  events: AgentWorkerEvent[];
  peakConcurrency: number;
  guardrails: AuditGuardrailSnapshot;
}

export interface LiveSwarmState {
  instanceId: string;
  auditId?: string;
  plan: LivingAuditPlan | null;
  activeWorkerIds: string[];
  events: AgentWorkerEvent[];
  evidence: EvidenceInput[];
  reports: AgentWorkerReport[];
  guardrails?: AuditGuardrailSnapshot;
  stopped: boolean;
  finished: boolean;
}

export interface AuditPlannerContext {
  auditId: string;
  repository: AuditRepositoryFacts;
  target: AuditTargetRef | null;
  objective: string;
  availableRoles: AgentWorkerRole[];
}

export interface PlannedWorker {
  role: AgentWorkerRole;
  objective: string;
  mandatory: boolean;
}

export interface AuditPlanningAgent {
  propose(context: AuditPlannerContext): Promise<PlannedWorker[]>;
}

function contentText(message: any): string {
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

function parseJsonObject(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Strands planner did not return JSON');
}

const ALLOWED_ROLES: readonly AgentWorkerRole[] = [
  'security-secrets',
  'browser-app-user',
  'api-chaos',
  'performance-discovery',
  'hypothesis',
  'investigator',
  'judge',
  'repair',
  'reverification',
];

export class StrandsAuditPlanningAgent implements AuditPlanningAgent {
  constructor(private readonly agent: Agent) {}

  async propose(context: AuditPlannerContext): Promise<PlannedWorker[]> {
    const prompt = [
      'Create the initial VERIFIAI Deep Audit worker plan.',
      'Return JSON only in this exact shape: {"workers":[{"role":"...","objective":"...","mandatory":true}]}.',
      'Use only roles listed in availableRoles. Prefer the four baseline specialist roles when applicable.',
      'Do not invent tools, credentials, targets, findings, or evidence.',
      'Repository facts and approved capabilities are authoritative.',
      JSON.stringify(context),
    ].join('\n');
    const result = await this.agent.invoke(prompt);
    const parsed = parseJsonObject(contentText((result as any).lastMessage));
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [];
    if (workers.length === 0) throw new Error('Strands planner returned no workers');
    return workers.map((worker: any, index: number) => {
      if (!ALLOWED_ROLES.includes(worker?.role)) throw new Error(`Planner returned invalid role at workers[${index}]`);
      if (typeof worker?.objective !== 'string' || !worker.objective.trim()) throw new Error(`Planner returned empty objective at workers[${index}]`);
      return { role: worker.role, objective: worker.objective.trim(), mandatory: worker.mandatory !== false };
    });
  }
}

export async function createStrandsPlanningAgent(
  selectionInput: ModelRunSelectionInput = {},
): Promise<{ planner: StrandsAuditPlanningAgent; modelProfileId: string }> {
  const selection = await resolveModelRunSelection(selectionInput);
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
      'You are the ephemeral VERIFIAI audit orchestrator.',
      'Plan work for isolated specialist agents; do not perform their verification yourself.',
      'Workers never communicate peer-to-peer. Never claim evidence you did not receive.',
      'Respect bounded concurrency, scoped tools, immutable shared targets, and isolated mutation targets.',
    ].join(' '),
  });
  return { planner: new StrandsAuditPlanningAgent(agent), modelProfileId: selection.profileId };
}

function clonePlan(plan: LivingAuditPlan): LivingAuditPlan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      evidenceRefs: [...task.evidenceRefs],
      report: task.report ? {
        ...task.report,
        findings: [...task.report.findings],
        evidence: [...task.report.evidence],
        evidenceRefs: [...task.report.evidenceRefs],
        followUps: [...task.report.followUps],
      } : undefined,
    })),
  };
}

function safeConstraints(source: Partial<AgentWorkerConstraints> | undefined): AgentWorkerConstraints {
  return {
    timeoutMs: Math.max(1000, Math.min(source?.timeoutMs ?? 120_000, 180_000)),
    maxToolCalls: Math.max(1, Math.min(source?.maxToolCalls ?? 24, 80)),
    maxEvidenceItems: Math.max(1, Math.min(source?.maxEvidenceItems ?? 100, 250)),
    destructiveAllowed: source?.destructiveAllowed === true,
    networkAllowlist: [...(source?.networkAllowlist ?? [])],
    maxEstimatedSpendUsd: Math.max(0.01, Math.min(source?.maxEstimatedSpendUsd ?? 0.5, 2.5)),
  };
}

export interface EphemeralAuditOrchestratorOptions {
  maxConcurrency?: number;
  maxRetries?: number;
  workerConstraints?: Partial<AgentWorkerConstraints>;
  guardrails?: Partial<AuditGuardrailConfig>;
  maxDynamicTasks?: number;
  now?: () => string;
}

export class EphemeralStrandsOrchestrator {
  readonly instanceId = randomUUID();
  private readonly maxConcurrency: number;
  private readonly maxRetries: number;
  private readonly workerConstraints: AgentWorkerConstraints;
  private readonly guardrailConfig: AuditGuardrailConfig;
  private readonly maxDynamicTasks: number;
  private readonly now: () => string;
  private active = new Map<string, AgentWorkerSession>();
  private stopped = false;
  private finished = false;
  private latestPlan: LivingAuditPlan | null = null;
  private liveEvents: AgentWorkerEvent[] = [];
  private liveEvidence: EvidenceInput[] = [];
  private liveReports: AgentWorkerReport[] = [];
  private ledger?: AuditGuardrailLedger;

  constructor(
    private readonly planner: AuditPlanningAgent,
    private readonly launcher: AgentWorkerLauncher,
    options: EphemeralAuditOrchestratorOptions = {},
  ) {
    this.guardrailConfig = normalizeGuardrails({
      ...options.guardrails,
      maxConcurrentWorkers: options.maxConcurrency ?? options.guardrails?.maxConcurrentWorkers,
      maxWorkerRetries: options.maxRetries ?? options.guardrails?.maxWorkerRetries,
    });
    this.maxConcurrency = this.guardrailConfig.maxConcurrentWorkers;
    this.maxRetries = this.guardrailConfig.maxWorkerRetries;
    this.maxDynamicTasks = Math.max(0, Math.min(options.maxDynamicTasks ?? 12, 24));
    this.workerConstraints = safeConstraints(options.workerConstraints);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  snapshot(): LivingAuditPlan | null {
    return this.latestPlan ? clonePlan(this.latestPlan) : null;
  }

  liveState(): LiveSwarmState {
    return {
      instanceId: this.instanceId,
      auditId: this.latestPlan?.auditId,
      plan: this.snapshot(),
      activeWorkerIds: [...this.active.keys()],
      events: [...this.liveEvents],
      evidence: [...this.liveEvidence],
      reports: [...this.liveReports],
      guardrails: this.ledger?.snapshot(),
      stopped: this.stopped,
      finished: this.finished,
    };
  }

  steer(objective: string, options: { role?: Extract<AgentWorkerRole, 'hypothesis' | 'investigator' | 'judge'>; evidenceRefs?: string[] } = {}): AuditPlanTask {
    const trimmed = objective.trim();
    if (!trimmed) throw new Error('Steering objective is required');
    if (!this.latestPlan) throw new Error('Audit has not started');
    if (this.finished || this.stopped) throw new Error('Audit is no longer accepting steering');
    const role = options.role ?? 'investigator';
    const duplicate = this.latestPlan.tasks.find((task) => task.role === role && task.objective === trimmed && task.state !== 'failed');
    if (duplicate) return { ...duplicate, evidenceRefs: [...duplicate.evidenceRefs] };
    const task: AuditPlanTask = {
      id: `TASK-STEER-${randomUUID().slice(0, 8)}`,
      role,
      objective: trimmed,
      mandatory: false,
      state: 'queued',
      attempts: 0,
      evidenceRefs: [...new Set(options.evidenceRefs ?? [])],
    };
    this.latestPlan.tasks.unshift(task);
    this.touch(this.latestPlan);
    return { ...task, evidenceRefs: [...task.evidenceRefs] };
  }

  async stop(reason = 'orchestrator stopped'): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.active.values()].map((session) => session.stop(reason)));
  }

  private touch(plan: LivingAuditPlan): void {
    plan.revision += 1;
    plan.updatedAt = this.now();
    this.latestPlan = plan;
  }

  async run(input: AuditRunInput): Promise<AuditRunResult> {
    if (this.latestPlan || this.active.size) throw new Error('Ephemeral orchestrator instances run exactly one audit');
    const auditId = input.auditId ?? `AUD-${randomUUID()}`;
    const objective = input.objective ?? 'Find real user-impacting failures and produce executed evidence.';
    const planned = await this.planner.propose({
      auditId,
      repository: input.repository,
      target: input.target,
      objective,
      availableRoles: [...ALLOWED_ROLES],
    });
    const seen = new Set<string>();
    const tasks: AuditPlanTask[] = planned.map((worker, index) => {
      const key = `${worker.role}:${worker.objective}`;
      if (seen.has(key)) throw new Error(`Planner returned duplicate worker: ${key}`);
      seen.add(key);
      const skipReason = input.inapplicable?.[worker.role];
      return {
        id: `TASK-${index + 1}-${randomUUID().slice(0, 8)}`,
        role: worker.role,
        objective: worker.objective,
        mandatory: worker.mandatory,
        state: skipReason ? 'skipped' : 'queued',
        attempts: 0,
        evidenceRefs: [],
        skipReason,
      };
    });
    const createdAt = this.now();
    const plan: LivingAuditPlan = { auditId, revision: 1, tasks, createdAt, updatedAt: createdAt };
    this.latestPlan = plan;
    const reports = this.liveReports;
    const evidence = this.liveEvidence;
    const events = this.liveEvents;
    const ledger = new AuditGuardrailLedger(this.guardrailConfig);
    this.ledger = ledger;
    const evidenceKeys = new Set<string>();
    const acceptEvidence = (item: EvidenceInput) => {
      const key = JSON.stringify(item);
      if (evidenceKeys.has(key)) return;
      ledger.recordEvidence(item);
      evidenceKeys.add(key);
      evidence.push(item);
    };
    let peakConcurrency = 0;
    let dynamicTasks = 0;

    const enqueueFollowUp = (role: AgentWorkerRole, objective: string, evidenceRefs: string[], reason: string): void => {
      if (dynamicTasks >= this.maxDynamicTasks) return;
      const key = `${role}:${objective}`;
      if (seen.has(key)) return;
      seen.add(key);
      dynamicTasks += 1;
      plan.tasks.push({
        id: `TASK-DYN-${dynamicTasks}-${randomUUID().slice(0, 8)}`,
        role,
        objective,
        mandatory: false,
        state: input.inapplicable?.[role] ? 'skipped' : 'queued',
        attempts: 0,
        evidenceRefs: [...new Set(evidenceRefs)],
        skipReason: input.inapplicable?.[role],
        lastError: input.inapplicable?.[role] ? reason : undefined,
      });
      this.touch(plan);
    };

    const runTask = async (task: AuditPlanTask): Promise<void> => {
      if (this.stopped) {
        task.state = 'incomplete';
        task.lastError = 'orchestrator stopped';
        this.touch(plan);
        return;
      }
      task.state = task.attempts ? 'retrying' : 'launching';
      task.attempts += 1;
      this.touch(plan);
      const workerId = `${task.role}-${randomUUID().slice(0, 8)}`;
      const grants = input.approvedTools[task.role] ?? [];
      const destructive = grants.some((grant) => grant.destructive === true);
      const target = destructive && input.target?.environment !== 'isolated-mutation'
        ? null
        : input.target;
      const brief: AgentWorkerLaunchBrief = {
        contractVersion: AGENT_WORKER_CONTRACT_VERSION,
        auditId,
        workerId,
        role: task.role,
        objective: task.objective,
        repository: input.repository,
        target,
        tools: grants,
        evidenceRefs: [...task.evidenceRefs],
        modelProfileId: input.modelProfileId,
        constraints: {
          ...this.workerConstraints,
          destructiveAllowed: destructive && target?.environment === 'isolated-mutation',
        },
      };

      let session: AgentWorkerSession | undefined;
      let endWorker: (() => void) | undefined;
      try {
        endWorker = ledger.beginWorker(brief.constraints.maxEstimatedSpendUsd ?? 0);
        session = await this.launcher.launch(brief, async (event) => {
          if (event.auditId !== auditId || event.workerId !== workerId) throw new Error('worker event identity mismatch');
          events.push(event);
          if (event.type === 'worker.evidence') acceptEvidence(event.evidence);
          this.touch(plan);
        });
        this.active.set(workerId, session);
        peakConcurrency = Math.max(peakConcurrency, this.active.size);
        task.state = 'running';
        this.touch(plan);
        const report = await session.result;
        if (report.auditId !== auditId || report.workerId !== workerId || report.role !== task.role) {
          throw new Error('worker report identity mismatch');
        }
        reports.push(report);
        for (const item of report.evidence) acceptEvidence(item);
        task.report = report;
        task.evidenceRefs = [...new Set([...task.evidenceRefs, ...report.evidenceRefs])];
        task.state = report.outcome === 'completed' ? 'completed' : report.outcome === 'incomplete' ? 'incomplete' : 'failed';
        this.touch(plan);

        for (const followUp of report.followUps) {
          enqueueFollowUp(followUp.role, followUp.objective, followUp.evidenceRefs, followUp.reason);
        }
        if (report.findingState === 'Unconfirmed' && report.findings.length > 0 && !report.followUps.some((item) => item.role === 'investigator')) {
          enqueueFollowUp(
            'investigator',
            `Independently investigate: ${report.findings[0]}`,
            report.evidenceRefs,
            'A suspicious unconfirmed finding requires narrow independent investigation.',
          );
        }
        const conflict = reports.find((other) =>
          other.workerId !== report.workerId &&
          other.findingState !== report.findingState &&
          other.findings.some((finding) => report.findings.includes(finding))
        );
        if (conflict) {
          enqueueFollowUp(
            'judge',
            `Resolve conflicting evidence about: ${report.findings.find((finding) => conflict.findings.includes(finding)) ?? report.summary}`,
            [...new Set([...report.evidenceRefs, ...conflict.evidenceRefs])],
            'Two isolated workers returned conflicting states for the same finding.',
          );
        }
      } catch (error: any) {
        task.lastError = String(error?.message ?? error);
        task.state = 'failed';
        this.touch(plan);
      } finally {
        endWorker?.();
        if (session) {
          this.active.delete(workerId);
          try { await this.launcher.teardown(session); }
          catch (error: any) {
            task.lastError = [task.lastError, `teardown: ${String(error?.message ?? error)}`].filter(Boolean).join('; ');
            if (task.state === 'completed') task.state = 'incomplete';
            this.touch(plan);
          }
        }
      }

      if ((task.state === 'failed' || task.state === 'incomplete') && task.attempts <= this.maxRetries && !this.stopped) {
        task.state = 'queued';
        this.touch(plan);
      }
    };

    const pending = new Set<Promise<void>>();
    while (!this.stopped && (plan.tasks.some((task) => task.state === 'queued') || pending.size)) {
      ledger.assertAuditTime();
      for (const task of plan.tasks) {
        if (task.state !== 'queued' || pending.size >= this.maxConcurrency) continue;
        let promise!: Promise<void>;
        promise = runTask(task).finally(() => pending.delete(promise));
        pending.add(promise);
      }
      if (pending.size) await Promise.race(pending);
    }
    if (pending.size) await Promise.allSettled([...pending]);

    for (const task of plan.tasks) {
      if (task.state === 'queued' || task.state === 'launching' || task.state === 'running' || task.state === 'retrying') {
        task.state = 'incomplete';
      }
    }
    this.touch(plan);

    const mandatory = plan.tasks.filter((task) => task.mandatory);
    const outcome: AuditRunResult['outcome'] =
      mandatory.some((task) => task.state === 'failed' || task.state === 'incomplete')
        ? 'incomplete'
        : mandatory.every((task) => task.state === 'completed' || task.state === 'skipped')
          ? 'completed'
          : 'failed';

    this.finished = true;
    return { auditId, outcome, plan: clonePlan(plan), reports: [...reports], evidence: [...evidence], events: [...events], peakConcurrency, guardrails: ledger.snapshot() };
  }
}
