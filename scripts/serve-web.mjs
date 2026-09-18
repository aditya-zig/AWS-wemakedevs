import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlagshipVerification } from '../services/integrations/flagship.mjs';
import { DeepAuditService } from '../services/deep-audit/index.mjs';

const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('request body exceeds 256 KiB safety limit');
  return raw ? JSON.parse(raw) : {};
}

export function createDemoServer({ deepAudit = new DeepAuditService() } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'POST' && url.pathname === '/api/demo/flagship') {
      try {
        const run = await runFlagshipVerification();
        return sendJson(res, 200, { run });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/demo/deep-audit') {
      try {
        const body = await readJson(req);
        const run = await deepAudit.run(body);
        return sendJson(res, 200, { run });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }

    const runRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)$/);
    if (req.method === 'GET' && runRoute) {
      const run = deepAudit.get(decodeURIComponent(runRoute[1]));
      return run ? sendJson(res, 200, { run }) : sendJson(res, 404, { error: 'run not found' });
    }

    const steerRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/steer$/);
    if (req.method === 'POST' && steerRoute) {
      try {
        const body = await readJson(req);
        const event = await deepAudit.steer(decodeURIComponent(steerRoute[1]), body.instruction);
        return sendJson(res, 200, { event });
      } catch (error) {
        return sendJson(res, /not found/i.test(String(error)) ? 404 : 400, { error: String(error?.message ?? error) });
      }
    }

    const prRoute = url.pathname.match(/^\/api\/demo\/deep-audit\/([^/]+)\/pr$/);
    if (req.method === 'POST' && prRoute) {
      try {
        const pr = deepAudit.createPrPackage(decodeURIComponent(prRoute[1]));
        return sendJson(res, 200, { pr });
      } catch (error) {
        return sendJson(res, /not found/i.test(String(error)) ? 404 : 409, { error: String(error?.message ?? error) });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('method not allowed');
    }

    const path = normalize(url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
    if (path.startsWith('..')) {
      res.writeHead(403);
      return res.end('forbidden');
    }

    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  createDemoServer().listen(Number(process.env.WEB_PORT ?? 4173), () => {
    console.log('VERIFIAI demo web: http://localhost:4173');
  });
}
