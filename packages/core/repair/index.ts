import { randomUUID } from 'node:crypto';
import type { Evidence, Experiment, Finding, Repair } from '../../contracts/src/index.js';
import type { EvidenceJudge } from '../judge/index.js';

export interface PatchWorkspace { apply(finding: Finding): Promise<{ branch: string; patch: string }>; }
export interface ReverificationRunner { rerun(experiments: readonly Experiment[]): Promise<{ experiments: Experiment[]; evidence: Evidence[] }>; }

export class RepairLoop {
  constructor(private readonly judge: EvidenceJudge, private readonly patcher: PatchWorkspace, private readonly rerunner: ReverificationRunner) {}

  async approveAndVerify(finding: Finding, experiments: readonly Experiment[], evidence: readonly Evidence[]): Promise<Repair> {
    const before = this.judge.judge(finding.requirementId, experiments, evidence);
    const applied = await this.patcher.apply(finding);
    const rerun = await this.rerunner.rerun(experiments.filter((item) => item.requirementId === finding.requirementId));
    const after = this.judge.judge(finding.requirementId, rerun.experiments, rerun.evidence);
    return {
      id: `RPR-${randomUUID()}`,
      findingId: finding.id,
      requirementId: finding.requirementId,
      status: after.verdict === 'VERIFIED' ? 'verified' : 'applied',
      branch: applied.branch,
      patch: applied.patch,
      before,
      after,
    };
  }
}
