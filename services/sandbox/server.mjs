import { createServer } from 'node:http';
import { SandboxManager } from './runtime.mjs';

export function createSandboxServer({ root } = {}) {
  const manager = new SandboxManager(root ? { root } : undefined);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, mode: 'local-fallback' });
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    if (req.method === 'POST' && url.pathname === '/sandboxes') return json(201, await manager.create(parsed.runId, parsed));
    const match = url.pathname.match(/^\/sandboxes\/([^/]+)$/);
    if (req.method === 'DELETE' && match) { await manager.destroy(match[1]); return json(200, { ok: true }); }
    const faultMatch = url.pathname.match(/^\/sandboxes\/([^/]+)\/faults$/);
    if (req.method === 'POST' && faultMatch) return json(201, manager.injectFault(faultMatch[1], parsed));
    const clearMatch = url.pathname.match(/^\/sandboxes\/([^/]+)\/faults\/clear$/);
    if (req.method === 'POST' && clearMatch) return json(200, manager.clearFaults(clearMatch[1]));
    return json(404, { error: 'not found' });
  });
  return { server, manager };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SANDBOX_PORT ?? 8790);
  const { server } = createSandboxServer();
  server.listen(port, () => console.log(`VERIFIAI sandbox fallback listening on :${port}`));
}
