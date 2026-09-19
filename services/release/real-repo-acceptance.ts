import type { AuditRunResult } from '../orchestrator/strands-orchestrator.js';

export const REQUIRED_DEEP_AUDIT_ENGINES = Object.freeze({
  'security-secrets': [['strix'], ['zap']],
  'browser-app-user': [['mirofish'], ['browser-use', 'cua']],
  'api-chaos': [['schemathesis'], ['toxiproxy']],
  'performance-discovery': [['locust', 'k6']],
} as const);

export interface RealRepoAcceptance {
  ok: boolean;
  failures: string[];
  engines: Record<string, string[]>;
}

function executedOutcome(item: any): boolean {
  return item?.executed === true && ['pass', 'fail'].includes(String(item?.payload?.outcome ?? '').toLowerCase());
}

export function assessRealRepoAcceptance(run: AuditRunResult): RealRepoAcceptance {
  const failures: string[] = [];
  const engines: Record<string, string[]> = {};

  if (run.outcome !== 'completed') failures.push(`audit outcome is ${run.outcome}, expected completed`);
  if (run.guardrails?.withinGuardrails !== true) failures.push('audit exceeded or did not prove configured guardrails');

  for (const [role, groups] of Object.entries(REQUIRED_DEEP_AUDIT_ENGINES)) {
    const task = run.plan.tasks.find((item) => item.role === role);
    if (!task) {
      failures.push(`missing mandatory baseline role: ${role}`);
      continue;
    }
    if (task.state !== 'completed') {
      failures.push(`${role} state is ${task.state}, expected completed`);
    }

    const reports = run.reports.filter((item) => item.role === role && item.outcome === 'completed');
    if (reports.length === 0) {
      failures.push(`${role} has no completed worker report`);
      continue;
    }

    const sources = new Set(
      reports
        .flatMap((report) => report.evidence)
        .filter(executedOutcome)
        .map((item) => String(item.source ?? '').toLowerCase())
        .filter(Boolean),
    );
    engines[role] = [...sources].sort();

    for (const alternatives of groups) {
      if (!alternatives.some((engine) => sources.has(engine))) {
        failures.push(`${role} missing executed real-engine evidence: ${alternatives.join(' or ')}`);
      }
    }
  }

  return { ok: failures.length === 0, failures, engines };
}
