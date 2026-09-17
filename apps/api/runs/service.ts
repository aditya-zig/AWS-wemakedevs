import type { Experiment, RunEvent, VerificationRun } from '../../../packages/contracts/src/index.js';
import type { VerificationOrchestrator } from '../../../packages/core/orchestrator/index.js';

export class RunService {
  #runs = new Map<string, VerificationRun>();
  constructor(private readonly orchestrator: VerificationOrchestrator) {}

  async start(projectId: string, experiments: readonly Experiment[]): Promise<VerificationRun> {
    const run = await this.orchestrator.execute(projectId, experiments);
    this.#runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }

  get(runId: string): VerificationRun | undefined {
    const run = this.#runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  events(runId: string): RunEvent[] {
    return this.#runs.get(runId)?.events.map((event) => structuredClone(event)) ?? [];
  }
}
