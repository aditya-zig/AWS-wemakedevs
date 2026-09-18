import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlagshipVerification } from '../services/integrations/flagship.mjs';

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

export function createDemoServer() {
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
