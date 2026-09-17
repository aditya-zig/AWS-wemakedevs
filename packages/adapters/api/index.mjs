const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createApiAdapter() {
  let context = {};
  let captured = [];

  return {
    name: 'api',
    capabilities: ['http-status', 'json-invariant', 'latency-observation'],
    async healthcheck() { return { ok: typeof fetch === 'function' }; },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const config = context.environment?.api ?? {};
      const baseUrl = context.target?.baseUrl;
      if (!baseUrl) return { status: 'unknown', observations: ['target.baseUrl is required'], evidence: [] };

      const url = new URL(config.path ?? '/', baseUrl).toString();
      const started = performance.now();
      const response = await fetch(url, {
        method: config.method ?? 'GET',
        headers: config.headers ?? {},
        body: config.body == null ? undefined : JSON.stringify(config.body)
      });
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      const contentType = response.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json') ? await response.json() : await response.text();
      const expectedStatus = config.expectedStatus ?? 200;
      const statusOk = response.status === expectedStatus;
      const expectedJson = config.expectedJson ?? null;
      const jsonOk = expectedJson == null || (body && typeof body === 'object' && Object.entries(expectedJson).every(([key, value]) => same(body[key], value)));
      const passed = statusOk && jsonOk;
      const evidence = {
        kind: 'network',
        source: 'api',
        executed: true,
        payload: {
          experimentId: experiment.id,
          url,
          method: config.method ?? 'GET',
          status: response.status,
          expectedStatus,
          durationMs,
          expectedJson,
          jsonInvariantPassed: jsonOk,
          outcome: passed ? 'pass' : 'fail'
        }
      };
      captured.push(evidence);
      return {
        status: passed ? 'pass' : 'fail',
        observations: [passed ? `API invariant passed for ${url}` : `API invariant failed for ${url}`],
        evidence: [evidence]
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return []; }
  };
}
