import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (req, res) => {
  const raw = new URL(req.url ?? '/', 'http://localhost').pathname;
  const path = normalize(raw === '/' ? 'index.html' : raw.replace(/^\//, ''));
  if (path.startsWith('..')) { res.writeHead(403); return res.end('forbidden'); }
  try { const body = await readFile(join(root, path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('not found'); }
});
server.listen(Number(process.env.WEB_PORT ?? 4173), () => console.log('VERIFIAI demo web: http://localhost:4173'));
