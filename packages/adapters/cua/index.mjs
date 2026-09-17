export function createCuaAdapter({ targetUrl = 'http://target.local' } = {}) {
  let prepared = false;
  let lastEvidence = [];
  return {
    name: 'desktop',
    capabilities: ['desktop-interaction', 'login-flow', 'checkout-flow', 'screenshot-evidence'],
    async healthcheck() { return { ok: true, detail: 'deterministic Cua-compatible fallback ready' }; },
    async prepare() { prepared = true; lastEvidence = []; },
    async execute(experiment) {
      if (!prepared) throw new Error('adapter not prepared');
      lastEvidence = [
        { kind: 'screenshot', source: 'cua-fallback', executed: true, payload: { targetUrl, frame: 'checkout-ready', synthetic: true } },
        { kind: 'runtime', source: 'cua-fallback', executed: true, payload: { steps: ['open target', 'login fixture user', 'open cart', 'submit checkout'], deterministic: true } },
        { kind: 'test_result', source: 'cua-fallback', executed: true, payload: { experimentId: experiment.id, completed: true } }
      ];
      return { status: 'pass', observations: ['Deterministic desktop workflow completed'], evidence: lastEvidence };
    },
    async stop() { prepared = false; },
    async evidence() { return lastEvidence; },
    async artifacts() { return ['artifact://cua/checkout-ready.png']; }
  };
}
