import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundedText, commandHealth, runExternalCommand } from '../_external-command.mjs';

const LOCUST = { repo: 'locustio/locust', commit: 'b9636d95bffc94c3a1bf8bfd500633e63297470f', license: 'MIT' };
const K6 = { repo: 'grafana/k6', commit: '3fcf5388d78cb382f0c0d42ec556a06bfd1b8dee', license: 'AGPL-3.0-only' };

function py(value) { return JSON.stringify(String(value)); }

async function runLocust(cfg, baseUrl, experiment) {
  const dir = await mkdtemp(join(tmpdir(), 'verifiai-locust-'));
  const path = cfg.path ?? '/';
  const users = Math.max(1, Math.min(Number(cfg.users ?? cfg.concurrency ?? 2), 50));
  const spawnRate = Math.max(1, Math.min(Number(cfg.spawnRate ?? users), 50));
  const durationSec = Math.max(1, Math.min(Number(cfg.durationSec ?? 10), 120));
  const locustfile = join(dir, 'locustfile.py');
  await writeFile(locustfile, `from locust import HttpUser, task, between
class VerifiaiUser(HttpUser):
    wait_time = between(0.05, 0.2)
    @task
    def verify(self):
        self.client.get(${py(path)}, name=${py(path)})
`, 'utf8');
  const prefix = join(dir, 'stats');
  const args = ['-f', locustfile, '--headless', '--host', baseUrl, '-u', String(users), '-r', String(spawnRate), '-t', `${durationSec}s`, '--csv', prefix, '--only-summary'];
  const result = await runExternalCommand('locust', args, { timeoutMs: (durationSec + 30) * 1000 });
  const statsPath = `${prefix}_stats.csv`;
  const stats = await readFile(statsPath, 'utf8').catch(() => null);
  return {
    engine: 'Locust', upstream: LOCUST, command: ['locust', ...args], result,
    artifacts: stats ? [statsPath] : [], rawReport: stats,
    outcome: result.exitCode === 0 ? 'pass' : result.exitCode == null ? 'unknown' : 'fail',
    experimentId: experiment.id,
  };
}

async function runK6(cfg, baseUrl, experiment) {
  const dir = await mkdtemp(join(tmpdir(), 'verifiai-k6-'));
  const path = cfg.path ?? '/';
  const vus = Math.max(1, Math.min(Number(cfg.vus ?? cfg.concurrency ?? 2), 50));
  const durationSec = Math.max(1, Math.min(Number(cfg.durationSec ?? 10), 120));
  const maxP95Ms = Math.max(1, Number(cfg.maxP95Ms ?? 1000));
  const maxErrorRate = Math.max(0, Math.min(Number(cfg.maxErrorRate ?? 0.01), 1));
  const scriptPath = join(dir, 'scenario.js');
  const summaryPath = join(dir, 'summary.json');
  await writeFile(scriptPath, `import http from 'k6/http';
export const options = { vus: ${vus}, duration: '${durationSec}s', thresholds: { http_req_duration: ['p(95)<${maxP95Ms}'], http_req_failed: ['rate<${maxErrorRate}'] } };
export default function () { http.get(${JSON.stringify(new URL(path, baseUrl).toString())}); }
`, 'utf8');
  const args = ['run', '--summary-export', summaryPath, scriptPath];
  const result = await runExternalCommand('k6', args, { timeoutMs: (durationSec + 30) * 1000 });
  const report = await readFile(summaryPath, 'utf8').catch(() => null);
  return {
    engine: 'k6', upstream: K6, command: ['k6', ...args], result,
    artifacts: report ? [summaryPath, scriptPath] : [scriptPath], rawReport: report,
    outcome: result.exitCode === 0 ? 'pass' : result.exitCode == null ? 'unknown' : 'fail',
    experimentId: experiment.id,
  };
}

export function createPerformanceAdapter({ engine = 'locust' } = {}) {
  const selectedEngine = engine === 'k6' ? 'k6' : 'locust';
  let context = {};
  let captured = [];
  return {
    name: 'performance',
    capabilities: ['locust', 'k6', 'real-load-test'],
    async healthcheck() {
      const health = selectedEngine === 'k6'
        ? await commandHealth('k6', ['version'])
        : await commandHealth('locust', ['--version']);
      return { ok: health.ok, detail: health.detail };
    },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const cfg = { ...(context.environment?.performance ?? {}), engine: selectedEngine };
      const baseUrl = context.target?.baseUrl;
      if (!baseUrl) return { status: 'unknown', observations: ['performance engine requires target.baseUrl'], evidence: [] };
      const run = selectedEngine === 'k6' ? await runK6(cfg, baseUrl, experiment) : await runLocust(cfg, baseUrl, experiment);
      const evidence = {
        kind: 'metric',
        source: run.engine.toLowerCase(),
        executed: true,
        payload: {
          engine: run.engine, upstreamRepo: run.upstream.repo, upstreamCommit: run.upstream.commit, license: run.upstream.license,
          command: run.command, exitCode: run.result.exitCode, timedOut: run.result.timedOut, durationMs: run.result.durationMs,
          reportArtifacts: run.artifacts, report: boundedText(run.rawReport, 16000),
          stdout: boundedText(run.result.stdout), stderr: boundedText(run.result.stderr), outcome: run.outcome,
        },
      };
      captured.push(evidence);
      return { status: run.outcome, observations: [`Real ${run.engine} run ${run.outcome}`], evidence: [evidence] };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return captured.flatMap((item) => item.payload.reportArtifacts ?? []); },
  };
}
