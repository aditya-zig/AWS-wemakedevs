export type ExperimentStatus = 'pending' | 'running' | 'pass' | 'fail' | 'unknown';
export type ExperimentType = 'browser' | 'api' | 'security' | 'performance' | 'chaos' | 'customer';
export type ToolName = 'desktop' | 'api' | 'security' | 'performance' | 'chaos' | 'customer';
export type Verdict = 'VERIFIED' | 'FAILED' | 'UNKNOWN';

export interface RepositoryRef {
  provider: 'github';
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface Project {
  id: string;
  name: string;
  repository: RepositoryRef;
  branch: string;
  commitSha: string;
  createdAt: string;
}

export interface Requirement {
  id: string;
  text: string;
  invariants: string[];
  experimentTypes: ExperimentType[];
  targetTools: ToolName[];
}

export interface Experiment {
  id: string;
  requirementId: string;
  type: ExperimentType;
  tool: ToolName;
  description: string;
  status: ExperimentStatus;
  attempts: number;
  evidenceIds: string[];
}

export type EvidenceKind = 'test_result' | 'screenshot' | 'log' | 'trace' | 'network' | 'database' | 'metric' | 'runtime' | 'code';

export interface EvidenceInput {
  kind: EvidenceKind;
  source: string;
  executed: boolean;
  payload: Record<string, unknown>;
}

export interface ToolHealth { ok: boolean; detail?: string; }
export interface ToolPrepareContext { target: Record<string, unknown>; environment: Record<string, unknown>; }
export interface ToolExecutionOutput {
  status: Extract<ExperimentStatus, 'pass' | 'fail' | 'unknown'>;
  observations?: string[];
  evidence: EvidenceInput[];
}
export interface VerificationTool {
  name: ToolName | string;
  capabilities: string[];
  healthcheck(): Promise<ToolHealth>;
  prepare(context?: ToolPrepareContext): Promise<void>;
  execute(experiment: Experiment): Promise<ToolExecutionOutput>;
  stop(): Promise<void>;
  evidence(): Promise<EvidenceInput[]>;
  artifacts(): Promise<string[]>;
}

export interface Evidence extends EvidenceInput {
  id: string;
  runId: string;
  experimentId: string;
  requirementId: string;
  capturedAt: string;
}

export interface Finding {
  id: string;
  requirementId: string;
  experimentId: string;
  status: 'hypothesis' | 'tested' | 'confirmed' | 'rejected';
  summary: string;
  rootCause?: string;
  evidenceIds: string[];
}

export interface JudgeResult {
  requirementId: string;
  verdict: Verdict;
  reason: string;
  evidenceIds: string[];
}

export interface Repair {
  id: string;
  findingId: string;
  requirementId: string;
  status: 'proposed' | 'applied' | 'verified' | 'failed';
  branch: string;
  patch: string;
  before: JudgeResult;
  after: JudgeResult;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: 'run.started' | 'experiment.started' | 'experiment.passed' | 'experiment.failed' | 'experiment.unknown' | 'run.completed';
  at: string;
  experimentId?: string;
  message?: string;
}

export interface VerificationRun {
  id: string;
  projectId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  experiments: Experiment[];
  evidence: Evidence[];
  events: RunEvent[];
  counts: ExperimentStatusCounts;
  startedAt: string;
  completedAt?: string;
}

export interface ExperimentStatusCounts {
  pending: number;
  running: number;
  pass: number;
  fail: number;
  unknown: number;
}

export const isTerminalExperimentStatus = (status: ExperimentStatus): boolean =>
  status === 'pass' || status === 'fail' || status === 'unknown';

export function summarizeExperimentStatuses(experiments: readonly Experiment[]): ExperimentStatusCounts {
  const counts: ExperimentStatusCounts = { pending: 0, running: 0, pass: 0, fail: 0, unknown: 0 };
  for (const experiment of experiments) counts[experiment.status] += 1;
  return counts;
}

/**
 * Real-agent control-plane contract (architecture freeze 2026-09-18).
 * Deterministic VerificationTool implementations remain reusable tools/evidence
 * producers; they are never represented as autonomous workers.
 */
export const AGENT_WORKER_CONTRACT_VERSION = 'verifiai.worker.v1' as const;
export const AGENT_WORKER_LIFECYCLE = [
  'queued',
  'launching',
  'running',
  'reporting',
  'tearing_down',
  'completed',
] as const;

export type AgentWorkerLifecyclePhase =
  | typeof AGENT_WORKER_LIFECYCLE[number]
  | 'incomplete'
  | 'failed';

export type AgentWorkerRole =
  | 'security-secrets'
  | 'browser-app-user'
  | 'api-chaos'
  | 'performance-discovery'
  | 'hypothesis'
  | 'investigator'
  | 'judge'
  | 'repair'
  | 'reverification';

export type EvidenceFindingState = 'Confirmed' | 'Unconfirmed' | 'Unknown' | 'Incomplete';
export type ToolExecutionClass = 'agent-native' | 'deterministic-tool';

export interface AuditRepositoryFacts {
  provider: 'github';
  fullName: string;
  url: string;
  branch: string;
  commitSha: string;
}

export interface AuditTargetRef {
  id: string;
  url?: string;
  environment: 'shared-observation' | 'isolated-mutation';
  immutable?: boolean;
}

export interface AgentToolGrant {
  name: string;
  capabilities: string[];
  executionClass: ToolExecutionClass;
  destructive?: boolean;
}

export interface AgentWorkerConstraints {
  timeoutMs: number;
  maxToolCalls: number;
  maxEvidenceItems: number;
  destructiveAllowed: boolean;
  networkAllowlist: string[];
  maxEstimatedSpendUsd?: number;
}

export interface AgentWorkerLaunchBrief {
  contractVersion: typeof AGENT_WORKER_CONTRACT_VERSION;
  auditId: string;
  workerId: string;
  role: AgentWorkerRole;
  objective: string;
  repository: AuditRepositoryFacts;
  target: AuditTargetRef | null;
  tools: AgentToolGrant[];
  evidenceRefs: string[];
  modelProfileId: string;
  constraints: AgentWorkerConstraints;
}

export interface AgentWorkerStatusEvent {
  type: 'worker.status';
  auditId: string;
  workerId: string;
  at: string;
  phase: AgentWorkerLifecyclePhase;
  message: string;
  progress?: number;
}

export interface AgentWorkerEvidenceEvent {
  type: 'worker.evidence';
  auditId: string;
  workerId: string;
  at: string;
  evidence: EvidenceInput;
}

export interface AgentWorkerFollowUpRequest {
  role: Extract<AgentWorkerRole, 'hypothesis' | 'investigator' | 'judge' | 'reverification'>;
  objective: string;
  evidenceRefs: string[];
  reason: string;
}

export interface AgentWorkerReport {
  contractVersion: typeof AGENT_WORKER_CONTRACT_VERSION;
  auditId: string;
  workerId: string;
  role: AgentWorkerRole;
  outcome: 'completed' | 'incomplete' | 'failed';
  findingState: EvidenceFindingState;
  summary: string;
  findings: string[];
  evidence: EvidenceInput[];
  evidenceRefs: string[];
  followUps: AgentWorkerFollowUpRequest[];
  error?: string;
}

export type AgentWorkerEvent = AgentWorkerStatusEvent | AgentWorkerEvidenceEvent;
export type AgentWorkerEventSink = (event: AgentWorkerEvent) => void | Promise<void>;

export interface AgentWorkerSession {
  workerId: string;
  sessionId: string;
  result: Promise<AgentWorkerReport>;
  stop(reason?: string): Promise<void>;
}

export interface AgentWorkerLauncher {
  launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession>;
  teardown(session: AgentWorkerSession): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateAgentWorkerLaunchBrief(value: unknown): string[] {
  if (!isRecord(value)) return ['brief must be an object'];
  const errors: string[] = [];
  if (value.contractVersion !== AGENT_WORKER_CONTRACT_VERSION) errors.push('contractVersion must be verifiai.worker.v1');
  for (const key of ['auditId', 'workerId', 'objective', 'modelProfileId']) {
    if (!nonEmptyString(value[key])) errors.push(`${key} is required`);
  }
  const roles: readonly string[] = ['security-secrets','browser-app-user','api-chaos','performance-discovery','hypothesis','investigator','judge','repair','reverification'];
  if (!roles.includes(String(value.role ?? ''))) errors.push('role is invalid');

  const repository = value.repository;
  if (!isRecord(repository)) {
    errors.push('repository is required');
  } else {
    if (repository.provider !== 'github') errors.push('repository.provider must be github');
    for (const key of ['fullName', 'url', 'branch', 'commitSha']) {
      if (!nonEmptyString(repository[key])) errors.push(`repository.${key} is required`);
    }
  }

  if (!Array.isArray(value.tools)) errors.push('tools must be an array');
  if (!Array.isArray(value.evidenceRefs)) errors.push('evidenceRefs must be an array');

  const constraints = value.constraints;
  if (!isRecord(constraints)) {
    errors.push('constraints are required');
  } else {
    for (const key of ['timeoutMs', 'maxToolCalls', 'maxEvidenceItems']) {
      const item = constraints[key];
      if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) errors.push(`constraints.${key} must be > 0`);
    }
    if (typeof constraints.destructiveAllowed !== 'boolean') errors.push('constraints.destructiveAllowed must be boolean');
    if (!Array.isArray(constraints.networkAllowlist)) errors.push('constraints.networkAllowlist must be an array');
  }
  return errors;
}

export function assertAgentWorkerLaunchBrief(value: unknown): asserts value is AgentWorkerLaunchBrief {
  const errors = validateAgentWorkerLaunchBrief(value);
  if (errors.length) throw new Error(`Invalid agent worker launch brief: ${errors.join('; ')}`);
}
