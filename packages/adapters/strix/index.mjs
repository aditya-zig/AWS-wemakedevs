import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundedText, commandHealth, runExternalCommand } from '../_external-command.mjs';

const UPSTREAM = { repo: 'usestrix/strix', commit: '976835194d11171989c5f231fbd6eb0a8e4465dd', license: 'Apache-2.0' };

async function latestRunRecord(cwd) {
  const root = join(cwd, 'strix_runs');
  let names;
  try { names = await readdir(root, { withFileTypes: true }); } catch { return null; }
  const dirs = names.filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse();
  for (const name of dirs) {
    try {
      const path = join(root, name, 'run.json');
      const value = JSON.parse(await readFile(path, 'utf8'));
      return { name, path, value };
    } catch {}
  }
  return null;
}

export function createStrixAdapter({ command = 'strix', timeoutMs = 20 * 60_000, maxBudgetUsd = 2 } = {}) {
  let context = {};
  let captured = [];
  let runDir = null;
  return {
    name: 'security',
    capabilities: ['strix', 'real-security-scan', 'reproduction-evidence'],
    async healthcheck() {
      const health = await commandHealth(command, ['--help']);
      return { ok: health.ok, detail: health.ok ? `real Strix CLI available (${UPSTREAM.repo}@${UPSTREAM.commit})` : health.detail };
    },
    async prepare(next = {}) {
      context = next;
      captured = [];
      runDir = await mkdtemp(join(tmpdir(), 'verifiai-strix-'));
    },
    async execute(experiment) {
      const cfg = context.environment?.strix ?? {};
      const target = cfg.target ?? context.target?.baseUrl ?? context.target?.repository;
      if (!target) return { status: 'unknown', observations: ['Strix requires a target URL or repository'], evidence: [] };
      const budget = Math.max(0.1, Math.min(Number(cfg.maxBudgetUsd ?? maxBudgetUsd), 25));
      const scanMode = ['quick', 'standard', 'deep'].includes(cfg.scanMode) ? cfg.scanMode : 'quick';
      const args = ['-n', '--target', String(target), '--scan-mode', scanMode, '--max-budget', String(budget)];
      if (experiment?.description) args.push('--instruction', String(experiment.description).slice(0, 2000));
      const result = await runExternalCommand(command, args, { cwd: runDir, timeoutMs, env: cfg.env });
      const record = await latestRunRecord(runDir);
      const completed = record?.value?.status === 'completed';
      let status = 'unknown';
      if (completed && result.exitCode === 0) status = 'pass';
      if (completed && result.exitCode === 2) status = 'fail';
      const evidence = {
        kind: 'test_result',
        source: 'strix',
        executed: true,
        payload: {
          engine: 'Strix',
          upstreamRepo: UPSTREAM.repo,
          upstreamCommit: UPSTREAM.commit,
          license: UPSTREAM.license,
          command: [command, ...args],
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          runStatus: record?.value?.status ?? null,
          runName: record?.name ?? null,
          runRecordPath: record?.path ?? null,
          findings: record?.value?.findings ?? record?.value?.vulnerabilities ?? null,
          stdout: boundedText(result.stdout),
          stderr: boundedText(result.stderr),
          outcome: status,
        },
      };
      captured.push(evidence);
      return {
        status,
        observations: [status === 'unknown' ? 'Strix did not produce a completed run; lane is incomplete' : `Real Strix scan ${status}`],
        evidence: [evidence],
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return captured.flatMap((item) => item.payload.runRecordPath ? [item.payload.runRecordPath] : []); },
  };
}
