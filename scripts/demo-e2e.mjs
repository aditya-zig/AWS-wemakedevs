import { rm } from 'node:fs/promises';
import { DeepAuditService } from '../services/deep-audit/index.mjs';

const root = '/tmp/verifiai-clean-deep-demo';
const knowledgeFile = '/tmp/verifiai-clean-deep-demo-knowledge.json';
await rm(root, { recursive: true, force: true });
await rm(knowledgeFile, { force: true });

const service = new DeepAuditService({ sandboxRoot: root, knowledgeFile });
const runs = [];
for (let i = 1; i <= 2; i += 1) {
  runs.push(await service.run({
    runId: `clean-deep-demo-${i}`,
    repository: 'acme/checkout',
    commitSha: 'fixture-demo',
    guardrails: { maxRunUsd: 2.5, maxHttpRequests: 80, maxConcurrentEngines: 4 }
  }));
}

const summary = runs.map((run) => ({
  runId: run.runId,
  engines: run.engines.length,
  confirmedFindings: run.findings.filter((finding) => finding.state === 'Confirmed').length,
  incomplete: run.coverage.incomplete,
  fix: run.fix.status,
  targeted: `${run.fix.targeted.passed}/${run.fix.targeted.total}`,
  regressions: run.fix.regressionFailures,
  prReady: run.fix.pr.ready,
  spendUsd: run.guardrails.estimatedRunSpendUsd,
  hardRunCapUsd: run.guardrails.hardRunCapUsd,
  guardrails: run.guardrails.withinGuardrails
}));

const ok = summary.every((run) =>
  run.engines >= 10 &&
  run.confirmedFindings >= 1 &&
  run.fix === 'not-run' &&
  run.targeted === '0/0' &&
  run.regressions === null &&
  run.prReady === false &&
  run.guardrails === true &&
  run.spendUsd <= run.hardRunCapUsd
);

console.log(JSON.stringify({ ok, runs: summary }, null, 2));
if (!ok) process.exitCode = 1;

await rm(root, { recursive: true, force: true });
await rm(knowledgeFile, { force: true });
