import type { Evidence, Experiment, JudgeResult } from '../../contracts/src/index.js';

export class EvidenceJudge {
  judge(requirementId: string, experiments: readonly Experiment[], evidence: readonly Evidence[]): JudgeResult {
    const relevantExperiments = experiments.filter((experiment) => experiment.requirementId === requirementId);
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const accepted = (experiment: Experiment) => experiment.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is Evidence => Boolean(item && item.executed && item.source !== 'llm'));

    const acceptedEvidence = relevantExperiments.flatMap(accepted);
    const evidenceIds = acceptedEvidence.map((item) => item.id);
    if (relevantExperiments.length === 0) return { requirementId, verdict: 'UNKNOWN', reason: 'No experiments were planned.', evidenceIds };

    const failed = relevantExperiments.some((experiment) => experiment.status === 'fail' && accepted(experiment).some((item) => item.payload.outcome === 'fail'));
    if (failed) return { requirementId, verdict: 'FAILED', reason: 'An executed experiment produced failing evidence.', evidenceIds };

    const verified = relevantExperiments.every((experiment) =>
      experiment.status === 'pass' && accepted(experiment).some((item) => item.payload.outcome === 'pass'));
    if (verified) return { requirementId, verdict: 'VERIFIED', reason: 'Every planned experiment passed with executed non-LLM evidence.', evidenceIds };

    return { requirementId, verdict: 'UNKNOWN', reason: 'Executed evidence is insufficient for a verified or failed verdict.', evidenceIds };
  }
}
