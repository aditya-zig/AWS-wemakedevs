import { randomUUID } from 'node:crypto';
import { summarizeExperimentStatuses, type Evidence, type EvidenceInput, type Experiment, type ExperimentStatus, type RunEvent, type ToolName, type VerificationRun, type VerificationTool } from '../../contracts/src/index.js';

export interface ToolExecutionResult {
  status: Extract<ExperimentStatus, 'pass' | 'fail' | 'unknown'>;
  observations?: string[];
  evidence: EvidenceInput[];
}
export type ToolRunner = (experiment: Experiment) => Promise<ToolExecutionResult>;
export type RunEventListener = (event: RunEvent) => void;

export class VerificationOrchestrator {
  #listeners = new Set<RunEventListener>();
  constructor(private readonly runners: Map<ToolName, ToolRunner>) {}

  static fromTools(tools: readonly VerificationTool[]): VerificationOrchestrator {
    const runners = new Map<ToolName, ToolRunner>();
    for (const tool of tools) {
      runners.set(tool.name as ToolName, async (experiment) => {
        const health = await tool.healthcheck();
        if (!health.ok) throw new Error(`${tool.name} is unhealthy${health.detail ? `: ${health.detail}` : ''}`);
        return tool.execute(experiment);
      });
    }
    return new VerificationOrchestrator(runners);
  }
  onEvent(listener: RunEventListener): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  private emit(runId: string, type: RunEvent['type'], events: RunEvent[], experimentId?: string, message?: string): void {
    const event: RunEvent = { id: randomUUID(), runId, type, at: new Date().toISOString(), experimentId, message };
    events.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  async execute(projectId: string, planned: readonly Experiment[]): Promise<VerificationRun> {
    const id = `RUN-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const experiments = planned.map((experiment) => ({ ...experiment, evidenceIds: [...experiment.evidenceIds] }));
    const evidence: Evidence[] = [];
    const events: RunEvent[] = [];
    this.emit(id, 'run.started', events);

    for (const experiment of experiments) {
      experiment.status = 'running';
      experiment.attempts += 1;
      this.emit(id, 'experiment.started', events, experiment.id);
      try {
        const runner = this.runners.get(experiment.tool);
        if (!runner) throw new Error(`No runner registered for ${experiment.tool}`);
        const result = await runner({ ...experiment, evidenceIds: [...experiment.evidenceIds] });
        experiment.status = result.status;
        for (const input of result.evidence) {
          const item: Evidence = {
            ...input,
            id: randomUUID(),
            runId: id,
            experimentId: experiment.id,
            requirementId: experiment.requirementId,
            capturedAt: new Date().toISOString(),
          };
          evidence.push(item);
          experiment.evidenceIds.push(item.id);
        }
        this.emit(id, result.status === 'pass' ? 'experiment.passed' : result.status === 'fail' ? 'experiment.failed' : 'experiment.unknown', events, experiment.id);
      } catch (error: any) {
        experiment.status = 'unknown';
        const item: Evidence = {
          id: randomUUID(), runId: id, experimentId: experiment.id, requirementId: experiment.requirementId,
          kind: 'runtime', source: 'orchestrator', capturedAt: new Date().toISOString(), executed: true,
          payload: { outcome: 'unknown', error: String(error?.message || error) },
        };
        evidence.push(item);
        experiment.evidenceIds.push(item.id);
        this.emit(id, 'experiment.unknown', events, experiment.id, String(error?.message || error));
      }
    }

    this.emit(id, 'run.completed', events);
    return {
      id,
      projectId,
      status: 'completed',
      experiments,
      evidence,
      events,
      counts: summarizeExperimentStatuses(experiments),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
