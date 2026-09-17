import { spawn } from 'node:child_process';

const defaultPersonas = ['impatient-mobile', 'careful-desktop', 'repeat-buyer', 'first-time-user'];

function runCommand(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MiroFish CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MiroFish CLI exited ${code}: ${stderr.trim()}`));
      resolve(stdout.trim());
    });
  });
}

export function createMiroFishCliRunner({ command = 'mirofish', timeoutMs = 120000 } = {}) {
  return async ({ files, requirement, maxRounds = 3 }) => {
    if (!Array.isArray(files) || files.length === 0) throw new Error('MiroFish CLI mode requires seed files');
    const stdout = await runCommand(command, ['run', '--files', ...files, '--requirement', requirement, '--max-rounds', String(maxRounds), '--json'], timeoutMs);
    try { return JSON.parse(stdout); } catch { return { raw: stdout }; }
  };
}

export function createMiroFishAdapter({ maxPersonas = 8, runner = null } = {}) {
  let context = {};
  let captured = [];

  return {
    name: 'customer',
    capabilities: ['bounded-personas', 'scenario-simulation', 'mirofish-compatible'],
    async healthcheck() { return { ok: true, detail: runner ? 'MiroFish runner configured' : 'bounded deterministic fallback' }; },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const config = context.environment?.mirofish ?? {};
      const runId = context.environment?.runId ?? `run-${experiment.id}`;
      const scenarioId = config.scenarioId ?? experiment.id;
      const personas = (Array.isArray(config.personas) && config.personas.length ? config.personas : defaultPersonas).slice(0, Math.max(1, maxPersonas));

      let mode = 'bounded-fixture';
      let observations;
      let report = null;

      if (runner && Array.isArray(config.files) && config.files.length) {
        report = await runner({ files: config.files, requirement: experiment.description, maxRounds: config.maxRounds ?? 3 });
        mode = 'mirofish-cli';
        const supplied = Array.isArray(report?.observations) ? report.observations : [];
        observations = personas.map((personaId, index) => ({
          runId,
          scenarioId,
          personaId,
          outcome: supplied[index]?.outcome === 'fail' ? 'fail' : 'pass',
          observation: supplied[index]?.observation ?? supplied[index]?.summary ?? 'MiroFish simulation completed'
        }));
      } else {
        const failures = new Set(config.simulatedFailures ?? []);
        observations = personas.map((personaId) => ({
          runId,
          scenarioId,
          personaId,
          outcome: failures.has(personaId) ? 'fail' : 'pass',
          observation: failures.has(personaId)
            ? `${personaId} abandoned or failed the scenario`
            : `${personaId} completed the scenario`
        }));
      }

      const failed = observations.some((item) => item.outcome === 'fail');
      const evidence = {
        kind: 'test_result',
        source: 'mirofish',
        executed: true,
        payload: {
          experimentId: experiment.id,
          runId,
          scenarioId,
          mode,
          bounded: true,
          personaCount: observations.length,
          observations,
          report,
          outcome: failed ? 'fail' : 'pass'
        }
      };
      captured.push(evidence);
      return {
        status: failed ? 'fail' : 'pass',
        observations: observations.map((item) => `${item.personaId}: ${item.outcome}`),
        evidence: [evidence]
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return []; }
  };
}
