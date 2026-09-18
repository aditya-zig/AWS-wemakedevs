import { createServer } from 'node:http';
import { createStrixAdapter } from '../../packages/adapters/strix/index.mjs';
import { createSchemathesisAdapter } from '../../packages/adapters/schemathesis/index.mjs';
import { createPerformanceAdapter } from '../../packages/adapters/performance/index.mjs';
import { createToxiproxyAdapter } from '../../packages/adapters/toxiproxy/index.mjs';
import { createZapAdapter } from '../../packages/adapters/zap/index.mjs';
import { createMiroFishAdapter } from '../../packages/adapters/mirofish/index.mjs';

const MAX_BODY_BYTES = 256 * 1024;

function adapterFor(engine) {
  if (engine === 'strix') return createStrixAdapter();
  if (engine === 'schemathesis') return createSchemathesisAdapter();
  if (engine === 'locust') return createPerformanceAdapter({ engine: 'locust' });
  if (engine === 'k6') return createPerformanceAdapter({ engine: 'k6' });
  if (engine === 'toxiproxy') return createToxiproxyAdapter();
  if (engine === 'zap') return createZapAdapter();
  if (engine === 'mirofish') return createMiroFishAdapter();
  throw new Error(`unsupported external engine: ${engine}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function execute(body) {
  const engine = String(body?.engine ?? '');
  const adapter = adapterFor(engine);
  const context = body?.context && typeof body.context === 'object' ? body.context : {};
  const experiment = body?.experiment && typeof body.experiment === 'object'
    ? body.experiment
    : { id: `external-${Date.now()}`, description: 'Execute external verification engine' };

  await adapter.prepare(context);
  try {
    const health = await adapter.healthcheck();
    if (!health?.ok) {
      return {
        engine,
        status: 'unknown',
        observations: [health?.detail ?? `${engine} is unavailable`],
        evidence: [],
        health,
      };
    }
    const result = await adapter.execute(experiment);
    return { engine, health, ...result };
  } finally {
    await adapter.stop();
  }
}

export function createExternalEngineServer() {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        json(res, 200, { ok: true, service: 'verifiai-external-engines' });
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        const engines = ['strix', 'zap', 'schemathesis', 'locust', 'k6', 'toxiproxy', 'mirofish'];
        const checks = {};
        for (const engine of engines) {
          try { checks[engine] = await adapterFor(engine).healthcheck(); }
          catch (error) { checks[engine] = { ok: false, detail: String(error?.message ?? error) }; }
        }
        json(res, 200, { ok: Object.values(checks).some((item) => item.ok), engines: checks });
        return;
      }
      if (req.method === 'POST' && req.url === '/execute') {
        const body = await readJson(req);
        const result = await execute(body);
        json(res, 200, result);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      json(res, 400, { error: String(error?.message ?? error) });
    }
  });
}

if (process.argv[1]?.endsWith('server.mjs')) {
  const port = Number(process.env.PORT ?? 8789);
  createExternalEngineServer().listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ service: 'verifiai-external-engines', port, status: 'ready' }));
  });
}
