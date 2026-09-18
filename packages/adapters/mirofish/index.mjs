import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const UPSTREAM = {
  repo: '666ghj/MiroFish',
  commit: '39d849138ef254f6c737ab4c4705e5545dbe31d4',
  license: 'AGPL-3.0-only',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function serviceBase(value) {
  if (!value) return null;
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

export function createMiroFishAdapter({
  baseUrl = process.env.VERIFIAI_MIROFISH_URL,
  pollMs = 1500,
  timeoutMs = 15 * 60_000,
} = {}) {
  let context = {};
  let captured = [];
  const calls = [];

  async function request(path, options = {}) {
    if (!baseUrl) throw new Error('VERIFIAI_MIROFISH_URL is not configured');
    const url = new URL(path, serviceBase(baseUrl));
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(Math.min(120_000, timeoutMs)) });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    calls.push({ method: options.method ?? 'GET', path: url.pathname, status: response.status });
    if (!response.ok || body?.success === false) {
      throw new Error(`MiroFish ${options.method ?? 'GET'} ${url.pathname} failed: ${body?.error ?? `HTTP ${response.status}`}`);
    }
    return body?.data ?? body;
  }

  async function poll(path, terminal, options = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = options.post
        ? await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.post()) })
        : await request(path);
      const verdict = terminal(value);
      if (verdict.done) return { value, verdict };
      await sleep(pollMs);
    }
    throw new Error(`MiroFish poll timed out: ${path}`);
  }

  async function ensureProject(config, requirement) {
    if (config.projectId) return config.projectId;
    if (!Array.isArray(config.files) || config.files.length === 0) {
      throw new Error('MiroFish requires projectId or real seed files');
    }
    const form = new FormData();
    form.set('simulation_requirement', requirement);
    form.set('project_name', config.projectName ?? 'VERIFIAI customer simulation');
    if (config.additionalContext) form.set('additional_context', String(config.additionalContext));
    for (const path of config.files) {
      const bytes = await readFile(path);
      form.append('files', new Blob([bytes]), basename(path));
    }
    const ontology = await request('/api/graph/ontology/generate', { method: 'POST', body: form });
    if (!ontology?.project_id) throw new Error('MiroFish ontology response did not include project_id');
    return ontology.project_id;
  }

  async function ensureGraph(projectId) {
    const build = await request('/api/graph/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    if (build?.task_id && build?.reused !== true) {
      const task = await poll(`/api/graph/task/${encodeURIComponent(build.task_id)}`, (value) => ({
        done: value?.status === 'completed' || value?.status === 'failed',
        failed: value?.status === 'failed',
      }));
      if (task.verdict.failed) throw new Error(`MiroFish graph build failed: ${task.value?.error ?? 'unknown error'}`);
    }
    const project = await request(`/api/graph/project/${encodeURIComponent(projectId)}`);
    if (!project?.graph_id) throw new Error('MiroFish project has no graph_id after graph build');
    return project.graph_id;
  }

  async function ensureSimulation(projectId, graphId, config) {
    if (config.simulationId) return config.simulationId;
    const created = await request('/api/simulation/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        graph_id: graphId,
        enable_twitter: config.enableTwitter !== false,
        enable_reddit: config.enableReddit !== false,
      }),
    });
    if (!created?.simulation_id) throw new Error('MiroFish create response did not include simulation_id');
    return created.simulation_id;
  }

  async function ensurePrepared(simulationId, config) {
    const prepared = await request('/api/simulation/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        simulation_id: simulationId,
        parallel_profile_count: Math.max(1, Math.min(Number(config.parallelProfileCount ?? 5), 16)),
        force_regenerate: config.forceRegenerate === true,
      }),
    });
    if (prepared?.status === 'ready' || prepared?.already_prepared === true) return prepared;
    const taskId = prepared?.task_id;
    const result = await poll('/api/simulation/prepare/status', (value) => ({
      done: value?.status === 'ready' || value?.status === 'completed' || value?.status === 'failed',
      failed: value?.status === 'failed',
    }), { post: () => ({ task_id: taskId, simulation_id: simulationId }) });
    if (result.verdict.failed) throw new Error(`MiroFish preparation failed: ${result.value?.error ?? 'unknown error'}`);
    return result.value;
  }

  return {
    name: 'customer',
    capabilities: ['mirofish', 'real-persona-simulation', 'oasis-simulation'],
    async healthcheck() {
      if (!baseUrl) return { ok: false, detail: 'VERIFIAI_MIROFISH_URL is not configured' };
      try {
        await request('/api/graph/project/list');
        return { ok: true, detail: `real MiroFish API available (${UPSTREAM.repo}@${UPSTREAM.commit})` };
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
      }
    },
    async prepare(next = {}) { context = next; captured = []; calls.length = 0; },
    async execute(experiment) {
      const config = context.environment?.mirofish ?? {};
      const requirement = config.requirement ?? experiment.description;
      let projectId = config.projectId ?? null;
      let graphId = config.graphId ?? null;
      let simulationId = config.simulationId ?? null;

      if (!simulationId) {
        projectId = await ensureProject(config, requirement);
        graphId = graphId ?? await ensureGraph(projectId);
        simulationId = await ensureSimulation(projectId, graphId, config);
        await ensurePrepared(simulationId, config);
      }

      let runState = null;
      if (config.start !== false) {
        await request('/api/simulation/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            simulation_id: simulationId,
            platform: config.platform ?? 'parallel',
            max_rounds: Math.max(1, Math.min(Number(config.maxRounds ?? 3), 50)),
            enable_graph_memory_update: config.enableGraphMemoryUpdate === true,
          }),
        });
        const run = await poll(`/api/simulation/${encodeURIComponent(simulationId)}/run-status`, (value) => {
          const status = value?.runner_status;
          return { done: ['completed', 'failed', 'stopped'].includes(status), failed: status === 'failed' };
        });
        runState = run.value;
      } else {
        runState = await request(`/api/simulation/${encodeURIComponent(simulationId)}/run-status`);
      }

      const profiles = await request(`/api/simulation/${encodeURIComponent(simulationId)}/profiles`);
      const actions = await request(`/api/simulation/${encodeURIComponent(simulationId)}/actions?limit=100&offset=0`);
      const engineCompleted = runState?.runner_status === 'completed' || config.start === false;
      const engineFailed = runState?.runner_status === 'failed';
      const status = engineFailed ? 'fail' : engineCompleted ? 'pass' : 'unknown';

      const evidence = {
        kind: 'test_result',
        source: 'mirofish',
        executed: true,
        payload: {
          engine: 'MiroFish',
          upstreamRepo: UPSTREAM.repo,
          upstreamCommit: UPSTREAM.commit,
          license: UPSTREAM.license,
          projectId,
          graphId,
          simulationId,
          requirement,
          runState,
          profiles: profiles?.profiles ?? [],
          profileCount: profiles?.count ?? profiles?.profiles?.length ?? 0,
          actions: actions?.actions ?? [],
          actionCount: actions?.count ?? actions?.actions?.length ?? 0,
          apiCalls: [...calls],
          outcome: status,
        },
      };
      captured.push(evidence);
      return {
        status,
        observations: [
          `Real MiroFish simulation ${simulationId}: ${runState?.runner_status ?? 'state captured'}`,
          `${evidence.payload.profileCount} personas; ${evidence.payload.actionCount} captured actions`,
        ],
        evidence: [evidence],
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return []; },
  };
}
