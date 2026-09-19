import { randomUUID } from 'node:crypto';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentToolGrant,
  type AgentWorkerEvent,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AuditRepositoryFacts,
  type AuditTargetRef,
  type EvidenceInput,
} from '../../../packages/contracts/src/index.js';

export type RepairSourceClass = 'confirmed-defect' | 'improvement-opportunity';

export interface RepairSource {
  classification: RepairSourceClass;
  summary: string;
  evidenceRefs: string[];
  visibleChange: boolean;
  baselineUrl?: string;
}

export interface ProofVideoArtifact {
  recordingKind: 'real';
  videoRef: string;
  startedAt: string;
  endedAt: string;
  redacted: boolean;
}

export interface ProofRecorder {
  capture(input: {
    auditId: string;
    beforeUrl?: string;
    afterUrl: string;
    scenario: string;
  }): Promise<ProofVideoArtifact>;
}

export interface RegressionResult {
  passed: boolean;
  adversarialPassed: boolean;
  evidence: EvidenceInput[];
  evidenceRefs: string[];
}

export interface RegressionRunner {
  run(input: {
    auditId: string;
    target: AuditTargetRef;
    source: RepairSource;
  }): Promise<RegressionResult>;
}

export interface ChangedAppProbe {
  probe(target: AuditTargetRef): Promise<EvidenceInput>;
}

export interface RepairFlowInput {
  auditId: string;
  repository: AuditRepositoryFacts;
  mutableTarget: AuditTargetRef;
  modelProfileId: string;
  networkAllowlist: string[];
  source: RepairSource;
  reverificationTools?: AgentToolGrant[];
}

export interface RepairFlowResult {
  status: 'verified' | 'rejected' | 'incomplete';
  classificationLabel: 'defect' | 'recommendation';
  patch?: { branch: string; diff: string; changedFiles: string[] };
  proofVideo?: ProofVideoArtifact;
  repairReport?: AgentWorkerReport;
  verifierReport?: AgentWorkerReport;
  evidence: EvidenceInput[];
  evidenceRefs: string[];
  pr: {
    ready: boolean;
    autoMerge: false;
    branch?: string;
    diff?: string;
    proofVideoRef?: string;
    verificationDecision: 'pass' | 'fail' | 'unknown';
  };
  events: AgentWorkerEvent[];
  reason: string;
}

function incomplete(input: RepairFlowInput, reason: string, extras: Partial<RepairFlowResult> = {}): RepairFlowResult {
  return {
    status: 'incomplete',
    classificationLabel: input.source.classification === 'confirmed-defect' ? 'defect' : 'recommendation',
    evidence: [],
    evidenceRefs: [...input.source.evidenceRefs],
    pr: { ready: false, autoMerge: false, verificationDecision: 'unknown' },
    events: [],
    reason,
    ...extras,
  };
}

function mutationPatch(report: AgentWorkerReport): { branch: string; diff: string; changedFiles: string[] } | null {
  const item = report.evidence.find((evidence) =>
    evidence.executed === true &&
    evidence.source === 'mutation-service' &&
    evidence.payload?.outcome === 'pass' &&
    typeof evidence.payload?.diff === 'string' &&
    evidence.payload.diff.length > 0
  );
  if (!item) return null;
  return {
    branch: typeof item.payload.branch === 'string' && item.payload.branch ? item.payload.branch : `verifiai/${report.auditId}`,
    diff: String(item.payload.diff),
    changedFiles: Array.isArray(item.payload.changedFiles)
      ? item.payload.changedFiles.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

export class RepairImprovementFlow {
  constructor(
    private readonly launcher: AgentWorkerLauncher,
    private readonly appProbe: ChangedAppProbe,
    private readonly regressionRunner: RegressionRunner,
    private readonly proofRecorder: ProofRecorder,
  ) {}

  async run(input: RepairFlowInput): Promise<RepairFlowResult> {
    if (input.mutableTarget.environment !== 'isolated-mutation') {
      return incomplete(input, 'Repair requires an isolated-mutation target.');
    }
    if (input.source.classification === 'confirmed-defect' && input.source.evidenceRefs.length === 0) {
      return incomplete(input, 'A defect repair requires evidence-backed confirmation.');
    }
    if (input.source.classification === 'improvement-opportunity' && input.source.evidenceRefs.length === 0) {
      return incomplete(input, 'An improvement recommendation requires evidence-backed opportunity data.');
    }

    const events: AgentWorkerEvent[] = [];
    const evidence: EvidenceInput[] = [];
    const repairWorkerId = `repair-${randomUUID().slice(0, 8)}`;
    const repair = await this.launcher.launch({
      contractVersion: AGENT_WORKER_CONTRACT_VERSION,
      auditId: input.auditId,
      workerId: repairWorkerId,
      role: 'repair',
      objective: [
        input.source.classification === 'confirmed-defect' ? 'Repair the confirmed defect.' : 'Implement a candidate improvement recommendation.',
        input.source.summary,
        'Apply the smallest evidence-backed patch in the isolated mutation workspace. Do not verify your own work.',
      ].join(' '),
      repository: input.repository,
      target: input.mutableTarget,
      tools: [
        {
          name: 'repository',
          capabilities: ['repository-read', 'source-inspection'],
          executionClass: 'agent-native',
        },
        {
          name: 'mutation',
          capabilities: ['mutation-apply', 'patch', 'edit'],
          executionClass: 'agent-native',
          destructive: true,
        },
      ],
      evidenceRefs: [...input.source.evidenceRefs],
      modelProfileId: input.modelProfileId,
      constraints: {
        timeoutMs: 180_000,
        maxToolCalls: 32,
        maxEvidenceItems: 120,
        destructiveAllowed: true,
        networkAllowlist: [...input.networkAllowlist],
        maxEstimatedSpendUsd: 0.6,
      },
    }, async (event) => {
      events.push(event);
      if (event.type === 'worker.evidence') evidence.push(event.evidence);
    });

    let repairReport: AgentWorkerReport;
    try {
      repairReport = await repair.result;
    } finally {
      await this.launcher.teardown(repair);
    }
    for (const item of repairReport.evidence) if (!evidence.includes(item)) evidence.push(item);
    if (repairReport.outcome !== 'completed') {
      return incomplete(input, 'Repair worker did not complete cleanly.', { repairReport, evidence, events });
    }

    const patch = mutationPatch(repairReport);
    if (!patch) {
      return incomplete(input, 'Repair worker completed without a real mutation-service diff.', { repairReport, evidence, events });
    }

    const changedAppEvidence = await this.appProbe.probe(input.mutableTarget);
    evidence.push(changedAppEvidence);
    if (changedAppEvidence.executed !== true || changedAppEvidence.payload?.outcome !== 'pass') {
      return incomplete(input, 'Changed application did not launch successfully.', {
        patch,
        repairReport,
        evidence,
        events,
      });
    }

    let proofVideo: ProofVideoArtifact | undefined;
    if (input.source.visibleChange) {
      if (!input.mutableTarget.url) {
        return incomplete(input, 'Visible repair has no changed-app URL for proof recording.', { patch, repairReport, evidence, events });
      }
      try {
        proofVideo = await this.proofRecorder.capture({
          auditId: input.auditId,
          beforeUrl: input.source.baselineUrl,
          afterUrl: input.mutableTarget.url,
          scenario: input.source.summary,
        });
      } catch (error: any) {
        return incomplete(input, `Real proof video capture failed: ${String(error?.message ?? error)}`, { patch, repairReport, evidence, events });
      }
      if (proofVideo.recordingKind !== 'real' || !proofVideo.videoRef) {
        return incomplete(input, 'Visible repair did not produce a real proof video artifact.', { patch, repairReport, evidence, events });
      }
    }

    const regression = await this.regressionRunner.run({
      auditId: input.auditId,
      target: input.mutableTarget,
      source: input.source,
    });
    evidence.push(...regression.evidence);
    if (!regression.passed || !regression.adversarialPassed) {
      return {
        status: 'rejected',
        classificationLabel: input.source.classification === 'confirmed-defect' ? 'defect' : 'recommendation',
        patch,
        proofVideo,
        repairReport,
        evidence,
        evidenceRefs: [...new Set([...input.source.evidenceRefs, ...regression.evidenceRefs])],
        pr: {
          ready: false,
          autoMerge: false,
          branch: patch.branch,
          diff: patch.diff,
          proofVideoRef: proofVideo?.videoRef,
          verificationDecision: 'fail',
        },
        events,
        reason: 'Regression or adversarial checks failed after the candidate patch.',
      };
    }

    const verifierWorkerId = `reverification-${randomUUID().slice(0, 8)}`;
    if (verifierWorkerId === repairWorkerId) throw new Error('Independent verifier must be a different worker');
    const verifier = await this.launcher.launch({
      contractVersion: AGENT_WORKER_CONTRACT_VERSION,
      auditId: input.auditId,
      workerId: verifierWorkerId,
      role: 'reverification',
      objective: `Independently verify the changed app against this evidence-backed goal: ${input.source.summary}. Return verificationDecision pass/fail/unknown. Do not mutate code.`,
      repository: input.repository,
      target: input.mutableTarget,
      tools: input.reverificationTools ?? [{
        name: 'api',
        capabilities: ['http-request', 'performance-probe'],
        executionClass: 'agent-native',
      }],
      evidenceRefs: [...new Set([...input.source.evidenceRefs, ...regression.evidenceRefs])],
      modelProfileId: input.modelProfileId,
      constraints: {
        timeoutMs: 180_000,
        maxToolCalls: 24,
        maxEvidenceItems: 120,
        destructiveAllowed: false,
        networkAllowlist: [...input.networkAllowlist],
        maxEstimatedSpendUsd: 0.5,
      },
    }, async (event) => {
      events.push(event);
      if (event.type === 'worker.evidence') evidence.push(event.evidence);
    });

    let verifierReport: AgentWorkerReport;
    try {
      verifierReport = await verifier.result;
    } finally {
      await this.launcher.teardown(verifier);
    }
    for (const item of verifierReport.evidence) if (!evidence.includes(item)) evidence.push(item);

    const verificationDecision = verifierReport.verificationDecision ?? 'unknown';
    const verified =
      verifierReport.outcome === 'completed' &&
      verificationDecision === 'pass' &&
      regression.passed &&
      regression.adversarialPassed &&
      (!input.source.visibleChange || Boolean(proofVideo));

    return {
      status: verified ? 'verified' : verificationDecision === 'fail' ? 'rejected' : 'incomplete',
      classificationLabel: input.source.classification === 'confirmed-defect' ? 'defect' : 'recommendation',
      patch,
      proofVideo,
      repairReport,
      verifierReport,
      evidence,
      evidenceRefs: [...new Set([...input.source.evidenceRefs, ...regression.evidenceRefs, ...verifierReport.evidenceRefs])],
      pr: {
        ready: verified,
        autoMerge: false,
        branch: patch.branch,
        diff: patch.diff,
        proofVideoRef: proofVideo?.videoRef,
        verificationDecision,
      },
      events,
      reason: verified
        ? 'Candidate patch passed changed-app launch, regression/adversarial checks and independent re-verification.'
        : 'Independent re-verification did not produce a passing decision.',
    };
  }
}

export class HttpProofRecorder implements ProofRecorder {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    if (!endpoint) throw new Error('Proof recorder endpoint is required; synthetic proof video is not allowed.');
  }

  async capture(input: { auditId: string; beforeUrl?: string; afterUrl: string; scenario: string }): Promise<ProofVideoArtifact> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`proof recorder returned HTTP ${response.status}`);
    const output: any = await response.json();
    if (output?.recordingKind !== 'real' || typeof output?.videoRef !== 'string' || !output.videoRef) {
      throw new Error('proof recorder did not return a real video artifact');
    }
    return {
      recordingKind: 'real',
      videoRef: output.videoRef,
      startedAt: String(output.startedAt ?? ''),
      endedAt: String(output.endedAt ?? ''),
      redacted: output.redacted === true,
    };
  }
}

export class TargetHealthProbe implements ChangedAppProbe {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}
  async probe(target: AuditTargetRef): Promise<EvidenceInput> {
    if (!target.url) return { kind: 'runtime', source: 'changed-app-probe', executed: false, payload: { outcome: 'unknown', reason: 'target URL missing' } };
    const url = new URL('/health', target.url).toString();
    try {
      const response = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      return {
        kind: 'runtime',
        source: 'changed-app-probe',
        executed: true,
        payload: { outcome: response.ok ? 'pass' : 'fail', status: response.status, url },
      };
    } catch (error: any) {
      return {
        kind: 'runtime',
        source: 'changed-app-probe',
        executed: true,
        payload: { outcome: 'fail', url, error: String(error?.message ?? error) },
      };
    }
  }
}


export class HttpRegressionRunner implements RegressionRunner {
  constructor(
    private readonly endpoint: string,
    private readonly token?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    if (!endpoint) throw new Error('Regression runner endpoint is required; synthetic regression evidence is not allowed.');
  }

  async run(input: {
    auditId: string;
    target: AuditTargetRef;
    source: RepairSource;
  }): Promise<RegressionResult> {
    const response = await this.fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`regression runner returned HTTP ${response.status}`);
    const output: any = await response.json();
    const evidence = Array.isArray(output?.evidence) ? output.evidence : [];
    const evidenceRefs = Array.isArray(output?.evidenceRefs)
      ? output.evidenceRefs.filter((value: unknown): value is string => typeof value === 'string')
      : [];
    if (typeof output?.passed !== 'boolean' || typeof output?.adversarialPassed !== 'boolean') {
      throw new Error('regression runner did not return boolean pass decisions');
    }
    if ((output.passed || output.adversarialPassed) && !evidence.some((item: any) => item?.executed === true)) {
      throw new Error('regression runner claimed pass without executed evidence');
    }
    return {
      passed: output.passed,
      adversarialPassed: output.adversarialPassed,
      evidence,
      evidenceRefs,
    };
  }
}
