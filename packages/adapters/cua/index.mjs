const UPSTREAM = {
  repo: 'trycua/cua',
  commit: '05f29785b508a4441ec3aa06c556a8e8b26c1d71',
  license: 'MIT',
};

export function createCuaAdapter({
  serviceUrl = process.env.VERIFIAI_CUA_URL,
  targetUrl = null,
  timeoutMs = 120_000,
} = {}) {
  let context = {};
  let lastEvidence = [];

  async function call(path, options = {}) {
    if (!serviceUrl) throw new Error('VERIFIAI_CUA_URL is not configured');
    const response = await fetch(new URL(path, serviceUrl), {
      ...options,
      signal: AbortSignal.timeout(Math.min(timeoutMs, 120_000)),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      throw new Error(`Cua service failed: ${body?.error ?? `HTTP ${response.status}`}`);
    }
    return body;
  }

  return {
    name: 'desktop',
    capabilities: ['cua', 'desktop-interaction', 'computer-use', 'screenshot-evidence'],
    async healthcheck() {
      if (!serviceUrl) return { ok: false, detail: 'VERIFIAI_CUA_URL is not configured' };
      try {
        const health = await call('/health');
        const identityOk = health.engine === 'Cua' && health.upstreamCommit === UPSTREAM.commit;
        return {
          ok: identityOk,
          detail: identityOk
            ? `real Cua service available (${UPSTREAM.repo}@${UPSTREAM.commit})`
            : 'Cua service identity/version mismatch',
        };
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
      }
    },
    async prepare(next = {}) { context = next; lastEvidence = []; },
    async execute(experiment) {
      const cfg = context.environment?.cua ?? {};
      const resolvedTarget = cfg.targetUrl ?? context.target?.baseUrl ?? targetUrl;
      if (!resolvedTarget) return { status: 'unknown', observations: ['Cua requires a target URL'], evidence: [] };
      const result = await call('/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: context.environment?.runId,
          targetUrl: resolvedTarget,
          objective: cfg.objective ?? experiment.description,
          persona: cfg.persona,
          model: cfg.model,
          provider: cfg.provider,
        }),
      });
      const identityOk = result.engine === 'Cua' && result.upstreamCommit === UPSTREAM.commit;
      const status = identityOk && result.ok === true ? 'pass' : 'unknown';
      lastEvidence = [{
        kind: 'screenshot',
        source: 'cua',
        executed: identityOk && result.ok === true,
        payload: {
          engine: 'Cua',
          upstreamRepo: UPSTREAM.repo,
          upstreamCommit: UPSTREAM.commit,
          license: UPSTREAM.license,
          targetUrl: resolvedTarget,
          objective: cfg.objective ?? experiment.description,
          provider: result.provider,
          model: result.model,
          durationMs: result.durationMs,
          actions: Array.isArray(result.actions) ? result.actions.slice(0, 100) : [],
          screenshotRefs: Array.isArray(result.screenshotRefs) ? result.screenshotRefs.slice(0, 20) : [],
          trajectoryRef: result.trajectoryRef ?? null,
          summary: result.summary ?? null,
          outcome: status,
        },
      }];
      return {
        status,
        observations: [status === 'pass' ? 'Real Cua ComputerAgent journey completed' : 'Cua service returned unverified identity/result'],
        evidence: lastEvidence,
      };
    },
    async stop() {},
    async evidence() { return [...lastEvidence]; },
    async artifacts() { return lastEvidence.flatMap((item) => item.payload.screenshotRefs ?? []); },
  };
}
