const UPSTREAM = {
  repo: 'zaproxy/zaproxy',
  commit: '0c440107128299bc48e59950cb09378271a31c9c',
  license: 'Apache-2.0',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createZapAdapter({
  apiUrl = process.env.VERIFIAI_ZAP_URL ?? 'http://127.0.0.1:8080',
  timeoutMs = 120_000,
  pollMs = 750,
} = {}) {
  let context = {};
  let captured = [];

  async function api(path, params = {}) {
    const url = new URL(path, apiUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.code) throw new Error(`ZAP API ${url.pathname} failed: ${body?.message ?? response.status}`);
    return body;
  }

  async function waitFor(path, params, pick) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const body = await api(path, params);
      const value = Number(pick(body));
      if (Number.isFinite(value) && value >= 100) return body;
      await sleep(pollMs);
    }
    throw new Error(`ZAP scan timed out while polling ${path}`);
  }

  return {
    name: 'zap',
    capabilities: ['zap', 'dast', 'spider', 'passive-scan'],
    async healthcheck() {
      try {
        const body = await api('/JSON/core/view/version/');
        return {
          ok: Boolean(body?.version),
          detail: body?.version ? `real ZAP ${body.version} available (${UPSTREAM.repo}@${UPSTREAM.commit})` : 'ZAP version unavailable',
        };
      } catch (error) {
        return { ok: false, detail: String(error?.message ?? error) };
      }
    },
    async prepare(next = {}) { context = next; captured = []; },
    async execute(experiment) {
      const cfg = context.environment?.zap ?? {};
      const target = cfg.target ?? context.target?.baseUrl;
      if (!target) return { status: 'unknown', observations: ['ZAP requires target.baseUrl'], evidence: [] };

      const targetUrl = new URL(target);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        return { status: 'unknown', observations: ['ZAP target must be HTTP(S)'], evidence: [] };
      }

      await api('/JSON/core/action/accessUrl/', { url: targetUrl.toString(), followRedirects: true });
      const spider = await api('/JSON/spider/action/scan/', {
        url: targetUrl.toString(),
        maxChildren: Math.max(1, Math.min(Number(cfg.maxChildren ?? 20), 100)),
        recurse: cfg.recurse !== false,
        subtreeOnly: true,
      });
      const scanId = spider?.scan;
      if (scanId == null) throw new Error('ZAP spider did not return scan id');
      await waitFor('/JSON/spider/view/status/', { scanId }, (body) => body?.status);

      const passiveStarted = Date.now();
      while (Date.now() - passiveStarted < timeoutMs) {
        const body = await api('/JSON/pscan/view/recordsToScan/');
        if (Number(body?.recordsToScan ?? 0) === 0) break;
        await sleep(pollMs);
      }

      const alertsBody = await api('/JSON/core/view/alerts/', {
        baseurl: targetUrl.toString(),
        start: 0,
        count: Math.max(1, Math.min(Number(cfg.maxAlerts ?? 200), 1000)),
      });
      const alerts = Array.isArray(alertsBody?.alerts) ? alertsBody.alerts : [];
      const highOrMedium = alerts.filter((alert) => ['High', 'Medium'].includes(String(alert?.risk)));
      const status = highOrMedium.length ? 'fail' : 'pass';
      const evidence = {
        kind: 'test_result',
        source: 'zap',
        executed: true,
        payload: {
          engine: 'OWASP ZAP',
          upstreamRepo: UPSTREAM.repo,
          upstreamCommit: UPSTREAM.commit,
          license: UPSTREAM.license,
          apiUrl,
          target: targetUrl.toString(),
          spiderScanId: String(scanId),
          alertCount: alerts.length,
          highOrMediumCount: highOrMedium.length,
          alerts: alerts.slice(0, 200),
          mode: 'spider+passive',
          outcome: status,
          experimentId: experiment?.id,
        },
      };
      captured.push(evidence);
      return {
        status,
        observations: [`Real ZAP spider/passive scan found ${alerts.length} alert(s), ${highOrMedium.length} medium/high`],
        evidence: [evidence],
      };
    },
    async stop() {},
    async evidence() { return [...captured]; },
    async artifacts() { return []; },
  };
}
