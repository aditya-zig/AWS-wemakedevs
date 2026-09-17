import { runFlagshipVerification } from '../services/integrations/flagship.mjs';

const runs = [];
for (let i = 1; i <= 2; i += 1) runs.push(await runFlagshipVerification({ runId: `clean-demo-${i}` }));
const summary = runs.map((run) => ({ runId: run.runId, before: run.before.verdict, after: run.after.verdict, regressions: run.regressions, chaosRestored: run.chaosRestored, evidence: run.evidence.length }));
console.log(JSON.stringify({ ok: summary.every((r) => r.before === 'FAILED' && r.after === 'VERIFIED' && r.regressions === 0 && r.chaosRestored), runs: summary }, null, 2));
