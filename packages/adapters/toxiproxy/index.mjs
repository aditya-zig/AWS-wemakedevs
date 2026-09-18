const UPSTREAM = { repo: 'Shopify/toxiproxy', commit: '40f7fd31bee529d824116bd2a11a9e3425e904ec', license: 'MIT' };

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

export function createToxiproxyAdapter({ apiUrl = process.env.TOXIPROXY_URL ?? 'http://127.0.0.1:8474' } = {}) {
  let context = {};
  let captured = [];
  let created = [];
  return {
    name: 'chaos',
    capabilities: ['toxiproxy', 'latency', 'timeout', 'reset-peer', 'bandwidth'],
    async healthcheck() {
      try {
        const { response } = await jsonFetch(new URL('/proxies', apiUrl));
        return {
          ok: response.ok,
          detail: response.ok ? `real Toxiproxy API available (${UPSTREAM.repo}@${UPSTREAM.commit})` : `Toxiproxy HTTP ${response.status}`,
        };
      } catch (error) {
        return { ok: false, detail: `Toxiproxy unavailable: ${error.message}` };
      }
    },
    async prepare(next = {}) { context = next; captured = []; created = []; },
    async execute(experiment) {
      const cfg = context.environment?.toxiproxy ?? {};
      const name = String(cfg.name ?? `verifiai-${experiment.id}`).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
      const upstream = cfg.upstream;
      const listen = cfg.listen;
      if (!upstream || !listen) {
        return { status: 'unknown', observations: ['Toxiproxy requires environment.toxiproxy.upstream and listen'], evidence: [] };
      }
      await jsonFetch(new URL(`/proxies/${encodeURIComponent(name)}`, apiUrl), { method: 'DELETE' }).catch(() => null);
      const create = await jsonFetch(new URL('/proxies', apiUrl), {
        method: 'POST',
        body: JSON.stringify({ name, listen, upstream, enabled: true }),
      });
      if (!create.response.ok) {
        return { status: 'unknown', observations: [`Toxiproxy proxy creation failed: HTTP ${create.response.status}`], evidence: [] };
      }
      created.push(name);
      const toxic = cfg.toxic ?? {
        name: 'latency',
        type: 'latency',
        stream: 'downstream',
        toxicity: 1,
        attributes: { latency: 8000, jitter: 0 },
      };
      const add = await jsonFetch(new URL(`/proxies/${encodeURIComponent(name)}/toxics`, apiUrl), {
        method: 'POST',
        body: JSON.stringify(toxic),
      });
      const probeUrl = cfg.probeUrl ?? null;
      let probe = null;
      if (probeUrl) {
        const started = Date.now();
        try {
          const response = await fetch(probeUrl, { signal: AbortSignal.timeout(Number(cfg.probeTimeoutMs ?? 12000)) });
          probe = { status: response.status, durationMs: Date.now() - started, ok: response.ok };
          await response.arrayBuffer();
        } catch (error) {
          probe = { status: 0, durationMs: Date.now() - started, ok: false, error: error.message };
        }
      }
      const status = add.response.ok ? (probe ? (probe.ok ? 'pass' : 'fail') : 'pass') : 'unknown';
      const evidence = {
        kind: 'network',
        source: 'toxiproxy',
        executed: true,
        payload: {
          engine: 'Toxiproxy', upstreamRepo: UPSTREAM.repo, upstreamCommit: UPSTREAM.commit, license: UPSTREAM.license,
          apiUrl, proxy: create.body, toxic: add.body, probe, outcome: status, experimentId: experiment.id,
        },
      };
      captured.push(evidence);
      return {
        status,
        observations: [probe ? `Real Toxiproxy fault injected; probe ${probe.ok ? 'reached target' : 'failed/timeout'}` : 'Real Toxiproxy toxic created'],
        evidence: [evidence],
      };
    },
    async stop() {
      await Promise.allSettled(created.map((name) => jsonFetch(new URL(`/proxies/${encodeURIComponent(name)}`, apiUrl), { method: 'DELETE' })));
      created = [];
    },
    async evidence() { return [...captured]; },
    async artifacts() { return []; },
  };
}
