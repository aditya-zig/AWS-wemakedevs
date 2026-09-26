const baseUrl = (process.env.VERIFIAI_TRUEFORGE_BASE_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
const model = process.env.VERIFIAI_TRUEFORGE_MODEL?.trim();
const token = process.env.VERIFIAI_TRUEFORGE_TOKEN;

if ((process.env.VERIFIAI_AGENT_HARNESS ?? 'trueforge') !== 'trueforge') {
  throw new Error('VERIFIAI_AGENT_HARNESS must be trueforge for this verification');
}
if (!model) throw new Error('VERIFIAI_TRUEFORGE_MODEL is required');

const response = await fetch(`${baseUrl}/healthz`, {
  headers: {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  signal: AbortSignal.timeout(15_000),
});

if (!response.ok) throw new Error(`TrueForge health failed: HTTP ${response.status}`);

console.log(JSON.stringify({
  ok: true,
  harness: 'trueforge',
  baseUrl,
  model,
  auth: token ? 'oidc-token-configured' : 'local-no-token',
  note: 'No model generation call was made.',
}, null, 2));
