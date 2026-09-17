function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

export function createPerformanceAdapter() {
  let context = {};
  let captured = [];

  return {
    name: 'performance',
    capabilities: ['latency', 'concurrency', 'error-rate'],
    async healthcheck() { return { ok: typeof fetch === 'function' }; },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const config = context.environment?.performance ?? {};
      const baseUrl = context.target?.baseUrl;
      if (!baseUrl) return { status: 'unknown', observations: ['target.baseUrl is required'], evidence: [] };

      const requestCount = Math.max(1, Math.min(100, Number(config.requests ?? 10)));
      const concurrency = Math.max(1, Math.min(requestCount, Number(config.concurrency ?? 2)));
      const maxP95Ms = Number(config.maxP95Ms ?? 1000);
      const maxErrorRate = Number(config.maxErrorRate ?? 0);
      const url = new URL(config.path ?? '/', baseUrl).toString();
      const durations = [];
      const statuses = [];
      let nextIndex = 0;

      async function worker() {
        while (true) {
          const index = nextIndex++;
          if (index >= requestCount) return;
          const started = performance.now();
          try {
            const response = await fetch(url, { method: config.method ?? 'GET' });
            durations.push(performance.now() - started);
            statuses.push(response.status);
            await response.arrayBuffer();
          } catch {
            durations.push(performance.now() - started);
            statuses.push(0);
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const p95Ms = percentile(durations, 0.95);
      const failures = statuses.filter((status) => status < 200 || status >= 400).length;
      const errorRate = failures / requestCount;
      const passed = p95Ms <= maxP95Ms && errorRate <= maxErrorRate;
      const evidence = {
        kind: 'metric',
        source: 'performance',
        executed: true,
        payload: {
          experimentId: experiment.id,
          url,
          requests: requestCount,
          concurrency,
          p95Ms,
          maxP95Ms,
          errorRate,
          maxErrorRate,
          statuses,
          outcome: passed ? 'pass' : 'fail'
        }
      };
      captured.push(evidence);
      return {
        status: passed ? 'pass' : 'fail',
        observations: [`p95=${p95Ms}ms threshold=${maxP95Ms}ms; errorRate=${errorRate}`],
        evidence: [evidence]
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return []; }
  };
}
