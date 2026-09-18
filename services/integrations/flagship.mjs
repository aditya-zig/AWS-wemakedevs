import { AdapterRuntime } from './runtime.mjs';
import { createCuaAdapter } from '../../packages/adapters/cua/index.mjs';
import { createStrixAdapter } from '../../packages/adapters/strix/index.mjs';
import { createToxiproxyAdapter } from '../../packages/adapters/toxiproxy/index.mjs';

const now = () => new Date().toISOString();

const experiment = (id, tool, type, description) => ({
  id,
  requirementId: 'R-CHECKOUT',
  type,
  tool,
  description,
  status: 'pending',
  attempts: 0,
  evidenceIds: [],
});

/**
 * Legacy compatibility helper.
 *
 * This function no longer fabricates the old FAILED -> VERIFIED story. It can
 * execute real Cua, Strix and Toxiproxy integrations when they are configured,
 * but repair/re-verification belongs to the real Strands swarm under /api/audits.
 */
export async function runFlagshipVerification({
  runId = `legacy-${Date.now()}`,
  targetUrl = process.env.VERIFIAI_FLAGSHIP_TARGET_URL,
  toxiproxy = null,
} = {}) {
  const events = [{ type: 'run.started', at: now(), runId, message: 'Legacy compatibility run started with real engines only' }];
  if (!targetUrl) {
    return {
      runId,
      status: 'incomplete',
      overall: 'Incomplete',
      reason: 'VERIFIAI_FLAGSHIP_TARGET_URL is required. The public product uses /api/audits and the real Strands swarm.',
      engines: [],
      evidence: [],
      events: [...events, { type: 'run.incomplete', at: now(), runId, message: 'No target URL; no synthetic evidence generated' }],
    };
  }

  const runtime = new AdapterRuntime()
    .register(createCuaAdapter())
    .register(createStrixAdapter())
    .register(createToxiproxyAdapter());

  const context = {
    target: { baseUrl: targetUrl },
    environment: {
      runId,
      cua: { targetUrl },
      toxiproxy: toxiproxy ?? {},
    },
  };

  const engines = [];
  for (const [name, exp] of [
    ['desktop', experiment('real-browser', 'desktop', 'browser', 'Use the target like a real customer')],
    ['security', experiment('real-security', 'security', 'security', 'Run a real bounded Strix security assessment')],
    ['chaos', experiment('real-chaos', 'chaos', 'chaos', 'Inject a real network fault through Toxiproxy')],
  ]) {
    const result = await runtime.execute(name, exp, context);
    engines.push({ name, ...result });
    events.push({
      type: result.status === 'unknown' ? 'engine.incomplete' : 'engine.completed',
      at: now(),
      runId,
      engine: name,
      message: result.observations?.[0] ?? result.status,
    });
  }

  const evidence = engines.flatMap((engine) => engine.evidence ?? []);
  const incomplete = engines.filter((engine) => engine.status === 'unknown').length;
  const overall = incomplete ? 'Incomplete' : 'Completed';
  events.push({ type: incomplete ? 'run.incomplete' : 'run.completed', at: now(), runId, message: overall });

  return {
    runId,
    status: incomplete ? 'incomplete' : 'completed',
    overall,
    targetUrl,
    engines,
    evidence,
    repair: null,
    verification: null,
    reason: incomplete
      ? 'One or more real upstream engines were unavailable or not configured. No fallback evidence was substituted.'
      : 'Real upstream engines executed. Repair and independent re-verification must run through /api/audits.',
    events,
  };
}
