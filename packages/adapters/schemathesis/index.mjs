import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundedText, commandHealth, runExternalCommand } from '../_external-command.mjs';

const UPSTREAM = { repo: 'schemathesis/schemathesis', commit: '94e23b5e497e83404aa681f5443ee32de2c3746f', license: 'MIT' };

export function createSchemathesisAdapter({ command = 'schemathesis', timeoutMs = 180000 } = {}) {
  let context = {};
  let captured = [];
  return {
    name: 'api-fuzz',
    capabilities: ['schemathesis', 'openapi', 'graphql', 'property-testing'],
    async healthcheck() {
      const health = await commandHealth(command, ['--version']);
      return { ok: health.ok, detail: health.ok ? `real Schemathesis CLI available (${UPSTREAM.repo}@${UPSTREAM.commit})` : health.detail };
    },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const cfg = context.environment?.schemathesis ?? {};
      const baseUrl = context.target?.baseUrl;
      const schemaUrl = cfg.schemaUrl ?? (baseUrl ? new URL(cfg.schemaPath ?? '/openapi.json', baseUrl).toString() : null);
      if (!schemaUrl) return { status: 'unknown', observations: ['Schemathesis requires schemaUrl or target.baseUrl'], evidence: [] };
      const reportDir = await mkdtemp(join(tmpdir(), 'verifiai-schemathesis-'));
      const maxExamples = Math.max(1, Math.min(Number(cfg.maxExamples ?? 25), 500));
      const args = ['run', schemaUrl, '--max-examples', String(maxExamples), '--continue-on-failure', '--report=ndjson', `--report-dir=${reportDir}`];
      const result = await runExternalCommand(command, args, { timeoutMs, env: cfg.env });
      const artifacts = (await readdir(reportDir).catch(() => [])).map((name) => join(reportDir, name));
      const status = result.exitCode === 0 ? 'pass' : result.exitCode === 1 ? 'fail' : 'unknown';
      const evidence = {
        kind: 'test_result',
        source: 'schemathesis',
        executed: true,
        payload: {
          engine: 'Schemathesis', upstreamRepo: UPSTREAM.repo, upstreamCommit: UPSTREAM.commit, license: UPSTREAM.license,
          command: [command, ...args], schemaUrl, maxExamples, exitCode: result.exitCode, timedOut: result.timedOut,
          durationMs: result.durationMs, reportArtifacts: artifacts, stdout: boundedText(result.stdout), stderr: boundedText(result.stderr),
          outcome: status, experimentId: experiment?.id,
        },
      };
      captured.push(evidence);
      return { status, observations: [`Real Schemathesis run ${status}`], evidence: [evidence] };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return captured.flatMap((item) => item.payload.reportArtifacts ?? []); },
  };
}
