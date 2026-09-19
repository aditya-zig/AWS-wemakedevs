import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRealRepoAcceptance } from '../services/release/real-repo-acceptance.js';

function evidence(source: string, outcome: 'pass' | 'fail' | 'unknown' = 'pass') {
  return { kind: 'test_result', source, executed: true, payload: { outcome } };
}

function report(role: any, sources: string[]) {
  return {
    contractVersion: '1.0',
    auditId: 'AUD-E2E',
    workerId: `worker-${role}`,
    role,
    outcome: 'completed',
    findingState: 'Unknown',
    summary: 'completed',
    findings: [],
    evidence: sources.map((source) => evidence(source)),
    evidenceRefs: [],
    followUps: [],
  };
}

function run() {
  const roles = ['security-secrets', 'browser-app-user', 'api-chaos', 'performance-discovery'];
  return {
    auditId: 'AUD-E2E',
    outcome: 'completed',
    plan: {
      auditId: 'AUD-E2E',
      revision: 1,
      createdAt: '2026-09-19T00:00:00Z',
      updatedAt: '2026-09-19T00:00:01Z',
      tasks: roles.map((role, index) => ({
        id: `TASK-${index}`,
        role,
        objective: 'deep audit',
        mandatory: true,
        state: 'completed',
        attempts: 1,
        evidenceRefs: [],
      })),
    },
    reports: [
      report('security-secrets', ['strix', 'zap']),
      report('browser-app-user', ['mirofish', 'cua']),
      report('api-chaos', ['schemathesis', 'toxiproxy']),
      report('performance-discovery', ['locust']),
    ],
    evidence: [],
    events: [],
    peakConcurrency: 4,
    guardrails: {
      activeWorkers: 0,
      peakWorkers: 4,
      workerLaunches: 4,
      evidenceBytes: 1024,
      estimatedSpendUsd: 0.8,
      hardRunSpendUsd: 2.5,
      elapsedMs: 1000,
      withinGuardrails: true,
    },
  } as any;
}

test('A11 accepts only a completed deep audit with real engine evidence in every baseline lane', () => {
  const result = assessRealRepoAcceptance(run());
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test('A11 rejects a skipped baseline lane even when overall orchestration says completed', () => {
  const value = run();
  value.plan.tasks.find((item: any) => item.role === 'browser-app-user').state = 'skipped';
  const result = assessRealRepoAcceptance(value);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((item) => item.includes('browser-app-user state is skipped')));
});

test('A11 rejects synthetic/weak evidence that does not prove the named upstream engine', () => {
  const value = run();
  const apiReport = value.reports.find((item: any) => item.role === 'api-chaos');
  apiReport.evidence = [evidence('target-http'), evidence('toxiproxy', 'unknown')];
  const result = assessRealRepoAcceptance(value);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((item) => item.includes('schemathesis')));
  assert.ok(result.failures.some((item) => item.includes('toxiproxy')));
});
