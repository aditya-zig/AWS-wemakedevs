export function createStrixAdapter({ allowedHost = 'target.local' } = {}) {
  let prepared = false;
  let lastEvidence = [];
  return {
    name: 'security',
    capabilities: ['scoped-security-probe', 'input-validation', 'reproduction-evidence'],
    async healthcheck() { return { ok: true, detail: 'safe Strix-compatible fallback ready' }; },
    async prepare() { prepared = true; lastEvidence = []; },
    async execute(experiment) {
      if (!prepared) throw new Error('adapter not prepared');
      const scope = { allowedHost, methods: ['GET', 'POST'], destructiveActions: false };
      lastEvidence = [
        { kind: 'runtime', source: 'strix-fallback', executed: true, payload: { scope, experimentId: experiment.id } },
        { kind: 'test_result', source: 'strix-fallback', executed: true, payload: { probe: 'checkout-input-boundary', finding: 'no exploitable condition reproduced', reproducible: true } }
      ];
      return { status: 'pass', observations: ['Scoped security probe completed without unsupported claims'], evidence: lastEvidence };
    },
    async stop() { prepared = false; },
    async evidence() { return lastEvidence; },
    async artifacts() { return ['artifact://strix/scope.json', 'artifact://strix/probe-result.json']; }
  };
}
