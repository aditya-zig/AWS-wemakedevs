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
