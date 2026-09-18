import { createServer } from 'node:http';

const port = 8081;
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'verifiai-local-target-smoke' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}).listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ service: 'verifiai-local-target-smoke', port, status: 'ready' }));
});
