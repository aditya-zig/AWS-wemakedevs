import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../apps/api/server.js';
import { CredentialVault, GitHubOAuthService, MemoryProjectStore, RepositoryImportService, type GitHubTransport } from '../packages/core/github/index.js';
import { VerificationOrchestrator } from '../packages/core/orchestrator/index.js';
import { RunService } from '../apps/api/runs/service.js';
import type { ToolName } from '../packages/contracts/src/index.js';

async function post(base: string, path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test('api exposes health, deterministic planning and repository import endpoints', async () => {
  const transport: GitHubTransport = {
    async request(method, path) {
      if (path === '/login/oauth/access_token') return { access_token: 'token-1' } as any;
      if (path === '/user/repos') return [{ full_name: 'acme/shop', html_url: 'https://github.com/acme/shop', default_branch: 'main' }] as any;
      if (path === '/repos/acme/shop/commits/main') return { sha: 'abc123' } as any;
      if (path === '/repos/acme/shop/branches') return [{ name: 'main', commit: { sha: 'abc123' } }] as any;
      throw new Error(`unexpected ${method} ${path}`);
    }
  };
  const vault = new CredentialVault();
  const oauth = new GitHubOAuthService({ clientId: 'client', clientSecret: 'secret', callbackUrl: 'http://localhost/callback', stateSecret: 'state-secret' }, transport, vault);
  const projects = new MemoryProjectStore();
  const importer = new RepositoryImportService(vault, transport, projects);
  const runners = new Map<ToolName, any>([
    ['chaos', async () => ({ status: 'fail', evidence: [{ kind: 'trace', source: 'chaos', executed: true, payload: { outcome: 'fail' } }] })],
    ['desktop', async () => ({ status: 'pass', evidence: [{ kind: 'screenshot', source: 'desktop', executed: true, payload: { outcome: 'pass' } }] })],
  ]);
  const runs = new RunService(new VerificationOrchestrator(runners));
  const server = createApiServer({ oauth, importer, runs });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const start = await post(base, '/api/github/oauth/start', { sessionId: 's1' });
    assert.equal(start.status, 200);
    const callback = await post(base, '/api/github/oauth/callback', { sessionId: 's1', code: 'code', state: start.body.state });
    assert.equal(callback.status, 200);

    const branches = await fetch(`${base}/api/github/repositories/acme/shop/branches?sessionId=s1`);
    assert.equal(branches.status, 200);
    const branchesBody = await branches.json() as any;
    assert.equal(branchesBody.branches[0].commitSha, 'abc123');

    const imported = await post(base, '/api/projects/import', { sessionId: 's1', fullName: 'acme/shop', branch: 'main', name: 'Shop' });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.project.commitSha, 'abc123');

    const parsed = await post(base, '/api/requirements/parse', { requirements: ['Checkout preserves cart when payment provider is unavailable.'] });
    assert.equal(parsed.status, 200);
    assert.ok(parsed.body.requirements[0].experimentTypes.includes('chaos'));

    const plan = await post(base, '/api/plans', { requirements: ['Checkout preserves cart when payment provider is unavailable.'] });
    assert.equal(plan.status, 200);
    assert.ok(plan.body.experiments.length >= 2);

    const started = await post(base, '/api/runs', { projectId: imported.body.project.id, experiments: plan.body.experiments });
    assert.equal(started.status, 201);
    assert.equal(started.body.run.status, 'completed');

    const fetched = await fetch(`${base}/api/runs/${started.body.run.id}`);
    assert.equal(fetched.status, 200);
    const fetchedBody = await fetched.json() as any;
    assert.equal(fetchedBody.run.id, started.body.run.id);

    const events = await fetch(`${base}/api/runs/${started.body.run.id}/events`);
    assert.equal(events.status, 200);
    const eventsBody = await events.json() as any;
    assert.equal(eventsBody.events.at(-1).type, 'run.completed');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error: any) => error ? reject(error) : resolve()));
  }
});
