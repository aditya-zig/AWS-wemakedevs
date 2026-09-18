import { URL } from 'node:url';

export interface AuditGuardrailConfig {
  maxConcurrentWorkers: number;
  maxWorkerRetries: number;
  maxAuditMs: number;
  maxBuildMs: number;
  maxTargetLifetimeMs: number;
  maxEvidenceBytes: number;
  hardRunSpendUsd: number;
}

export interface AuditGuardrailSnapshot {
  activeWorkers: number;
  peakWorkers: number;
  workerLaunches: number;
  evidenceBytes: number;
  estimatedSpendUsd: number;
  hardRunSpendUsd: number;
  elapsedMs: number;
  withinGuardrails: boolean;
}

export const DEFAULT_AUDIT_GUARDRAILS: Readonly<AuditGuardrailConfig> = Object.freeze({
  maxConcurrentWorkers: 4,
  maxWorkerRetries: 2,
  maxAuditMs: 15 * 60_000,
  maxBuildMs: 15 * 60_000,
  maxTargetLifetimeMs: 30 * 60_000,
  maxEvidenceBytes: 50 * 1024 * 1024,
  hardRunSpendUsd: 2.5,
});

export function normalizeGuardrails(input: Partial<AuditGuardrailConfig> = {}): AuditGuardrailConfig {
  return {
    maxConcurrentWorkers: Math.max(1, Math.min(input.maxConcurrentWorkers ?? 4, 4)),
    maxWorkerRetries: Math.max(0, Math.min(input.maxWorkerRetries ?? 1, 2)),
    maxAuditMs: Math.max(10_000, Math.min(input.maxAuditMs ?? DEFAULT_AUDIT_GUARDRAILS.maxAuditMs, 60 * 60_000)),
    maxBuildMs: Math.max(10_000, Math.min(input.maxBuildMs ?? DEFAULT_AUDIT_GUARDRAILS.maxBuildMs, 30 * 60_000)),
    maxTargetLifetimeMs: Math.max(30_000, Math.min(input.maxTargetLifetimeMs ?? DEFAULT_AUDIT_GUARDRAILS.maxTargetLifetimeMs, 2 * 60 * 60_000)),
    maxEvidenceBytes: Math.max(64 * 1024, Math.min(input.maxEvidenceBytes ?? DEFAULT_AUDIT_GUARDRAILS.maxEvidenceBytes, 250 * 1024 * 1024)),
    hardRunSpendUsd: Math.max(0.05, Math.min(input.hardRunSpendUsd ?? DEFAULT_AUDIT_GUARDRAILS.hardRunSpendUsd, 10)),
  };
}

export class AuditGuardrailLedger {
  private activeWorkers = 0;
  private peakWorkers = 0;
  private workerLaunches = 0;
  private evidenceBytes = 0;
  private estimatedSpendUsd = 0;
  private readonly startedAt: number;

  constructor(
    readonly config: AuditGuardrailConfig = normalizeGuardrails(),
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = clock();
  }

  assertAuditTime(): void {
    if (this.clock() - this.startedAt > this.config.maxAuditMs) {
      throw new Error('Guardrail: audit duration limit reached');
    }
  }

  beginWorker(estimatedSpendUsd = 0): () => void {
    this.assertAuditTime();
    if (this.activeWorkers >= this.config.maxConcurrentWorkers) {
      throw new Error('Guardrail: worker concurrency limit reached');
    }
    this.charge(estimatedSpendUsd);
    this.activeWorkers += 1;
    this.workerLaunches += 1;
    this.peakWorkers = Math.max(this.peakWorkers, this.activeWorkers);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    };
  }

  recordEvidence(value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (this.evidenceBytes + bytes > this.config.maxEvidenceBytes) {
      throw new Error('Guardrail: evidence size limit reached');
    }
    this.evidenceBytes += bytes;
  }

  charge(estimatedSpendUsd: number): void {
    if (!Number.isFinite(estimatedSpendUsd) || estimatedSpendUsd < 0) throw new Error('Guardrail: invalid spend estimate');
    if (this.estimatedSpendUsd + estimatedSpendUsd > this.config.hardRunSpendUsd) {
      throw new Error('Guardrail: hard run spend limit reached');
    }
    this.estimatedSpendUsd += estimatedSpendUsd;
  }

  snapshot(): AuditGuardrailSnapshot {
    const elapsedMs = this.clock() - this.startedAt;
    return {
      activeWorkers: this.activeWorkers,
      peakWorkers: this.peakWorkers,
      workerLaunches: this.workerLaunches,
      evidenceBytes: this.evidenceBytes,
      estimatedSpendUsd: Number(this.estimatedSpendUsd.toFixed(4)),
      hardRunSpendUsd: this.config.hardRunSpendUsd,
      elapsedMs,
      withinGuardrails:
        elapsedMs <= this.config.maxAuditMs &&
        this.activeWorkers <= this.config.maxConcurrentWorkers &&
        this.evidenceBytes <= this.config.maxEvidenceBytes &&
        this.estimatedSpendUsd <= this.config.hardRunSpendUsd,
    };
  }
}

export class WorkerNetworkPolicy {
  private readonly allowedHosts: Set<string>;

  constructor(hosts: readonly string[]) {
    this.allowedHosts = new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
    for (const host of this.allowedHosts) {
      if (host === '*' || host === '0.0.0.0/0' || host === '::/0' || host.includes('*')) {
        throw new Error(`Guardrail: unrestricted network entry is forbidden: ${host}`);
      }
      if (host.includes('/') && !host.startsWith('http')) {
        throw new Error(`Guardrail: CIDR entries are not accepted by the worker URL policy: ${host}`);
      }
    }
  }

  assertUrl(url: string): URL {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Guardrail: protocol ${parsed.protocol} is not allowed`);
    const host = parsed.hostname.toLowerCase();
    if (!this.allowedHosts.has(host) && !this.allowedHosts.has(parsed.host.toLowerCase())) {
      throw new Error(`Guardrail: outbound host is not allowlisted: ${parsed.host}`);
    }
    return parsed;
  }
}

export class CleanupStack {
  private readonly entries: Array<{ label: string; cleanup: () => Promise<void> }> = [];

  defer(label: string, cleanup: () => Promise<void>): void {
    this.entries.push({ label, cleanup });
  }

  async run(): Promise<void> {
    const failures: string[] = [];
    for (const entry of this.entries.reverse()) {
      try { await entry.cleanup(); }
      catch (error: any) { failures.push(`${entry.label}: ${String(error?.message ?? error)}`); }
    }
    this.entries.length = 0;
    if (failures.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`);
  }
}
