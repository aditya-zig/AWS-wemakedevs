import type { Evidence, Experiment, Finding } from '../../contracts/src/index.js';

export class Investigator {
  investigate(experiment: Experiment, evidence: readonly Evidence[]): Finding {
    const relevant = evidence.filter((item) => item.experimentId === experiment.id && item.executed && item.source !== 'llm');
    const failing = relevant.find((item) => item.payload.outcome === 'fail');
    const rootCause = typeof failing?.payload.rootCause === 'string' ? failing.payload.rootCause : undefined;
    return {
      id: `FND-${experiment.id}`,
      requirementId: experiment.requirementId,
      experimentId: experiment.id,
      status: rootCause ? 'confirmed' : failing ? 'tested' : 'hypothesis',
      summary: rootCause ? `Confirmed root cause: ${rootCause}` : failing ? 'Failure reproduced with executed evidence; root cause remains under investigation.' : 'No executed failing evidence is available yet.',
      rootCause,
      evidenceIds: relevant.map((item) => item.id),
    };
  }
}
