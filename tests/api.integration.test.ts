import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../apps/api/server.js';
import { CredentialVault, GitHubOAuthService, MemoryProjectStore, RepositoryImportService, type GitHubTransport } from '../packages/core/github/index.js';
import { GoogleOAuthService, type GoogleOAuthTransport } from '../packages/core/google/index.js';
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
      if (path === '/user') return { login: 'octocat', name: 'Octo Cat', avatar_url: 'https://example.test/octocat.png', email: 'octocat@example.test' } as any;
      if (path === '/user/repos') return [{ full_name: 'acme/shop', html_url: 'https://github.com/acme/shop', default_branch: 'main' }] as any;
      if (path === '/repos/acme/shop/commits/main') return { sha: 'abc123' } as any;
      if (path === '/repos/acme/shop/branches') return [{ name: 'main', commit: { sha: 'abc123' } }] as any;
      throw new Error(`unexpected ${method} ${path}`);
    }
  };
  const vault = new CredentialVault();
  const oauth = new GitHubOAuthService({ clientId: 'client', clientSecret: 'secret', callbackUrl: 'http://localhost/callback', stateSecret: 'state-secret' }, transport, vault);
  const googleTransport: GoogleOAuthTransport = {
    async exchangeCode(input) {
      assert.equal(input.code, 'google-code');
      return { access_token: 'google-token' };
    },
    async fetchUser(accessToken) {
      assert.equal(accessToken, 'google-token');
      return { sub: 'google-1', email: 'google@example.test', name: 'Google User', email_verified: true };
    },
  };
  const googleOauth = new GoogleOAuthService({ clientId: 'google-client', clientSecret: 'google-secret', callbackUrl: 'http://localhost/api/auth/google/callback', stateSecret: 'state-secret' }, googleTransport);
  const projects = new MemoryProjectStore();
  const importer = new RepositoryImportService(vault, transport, projects);
  const runners = new Map<ToolName, any>([
    ['chaos', async () => ({ status: 'fail', evidence: [{ kind: 'trace', source: 'chaos', executed: true, payload: { outcome: 'fail' } }] })],
    ['desktop', async () => ({ status: 'pass', evidence: [{ kind: 'screenshot', source: 'desktop', executed: true, payload: { outcome: 'pass' } }] })],
  ]);
  const runs = new RunService(new VerificationOrchestrator(runners));
  const server = createApiServer({ oauth, googleOauth, importer, runs, webUrl: 'http://localhost:4173', secureCookies: false });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const browserStart = await fetch(`${base}/api/auth/github`, { redirect: 'manual' });
    assert.equal(browserStart.status, 302);
    const browserCookie = browserStart.headers.get('set-cookie')?.split(';')[0];
    const authorizeLocation = browserStart.headers.get('location');
    assert.ok(browserCookie);
    assert.match(browserStart.headers.get('set-cookie') || '', /HttpOnly/);
    assert.match(browserStart.headers.get('set-cookie') || '', /SameSite=Lax/);
    assert.ok(authorizeLocation);
    const browserState = new URL(authorizeLocation!).searchParams.get('state');
    assert.ok(browserState);

    const browserCallback = await fetch(`${base}/api/auth/github/callback?code=browser-code&state=${encodeURIComponent(browserState!)}`, {
      headers: { cookie: browserCookie! },
      redirect: 'manual',
    });
    assert.equal(browserCallback.status, 302);
    assert.match(browserCallback.headers.get('location') || '', /auth=github/);

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie: browserCookie! } });
    assert.equal(me.status, 200);
    const meBody = await me.json() as any;
    assert.equal(meBody.authenticated, true);
    assert.equal(meBody.user.login, 'octocat');

    const browserRepos = await fetch(`${base}/api/github/repositories`, { headers: { cookie: browserCookie! } });
    assert.equal(browserRepos.status, 200);
    assert.equal(((await browserRepos.json()) as any).repositories[0].fullName, 'acme/shop');

    const browserImport = await fetch(`${base}/api/projects/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: browserCookie! },
      body: JSON.stringify({ fullName: 'acme/shop', branch: 'main', name: 'Browser Shop' }),
    });
    assert.equal(browserImport.status, 201);

    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: browserCookie! } });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${base}/api/auth/me`, { headers: { cookie: browserCookie! } });
    assert.equal(afterLogout.status, 401);

    const googleStart = await fetch(`${base}/api/auth/google?sessionId=attacker-controlled`, { redirect: 'manual' });
    assert.equal(googleStart.status, 302);
    const googleCookie = googleStart.headers.get('set-cookie')?.split(';')[0];
    const googleAuthorizeLocation = googleStart.headers.get('location');
    assert.ok(googleCookie);
    assert.equal(googleCookie!.includes('attacker-controlled'), false);
    assert.match(googleStart.headers.get('set-cookie') || '', /HttpOnly/);
    assert.ok(googleAuthorizeLocation);
    assert.equal(new URL(googleAuthorizeLocation!).origin, 'https://accounts.google.com');
    const googleState = new URL(googleAuthorizeLocation!).searchParams.get('state');
    assert.ok(googleState);

    const rejectedGoogleCallback = await fetch(`${base}/api/auth/google/callback?code=google-code&state=invalid-state`, {
      headers: { cookie: googleCookie! },
      redirect: 'manual',
    });
    assert.equal(rejectedGoogleCallback.status, 400);

    const googleRestart = await fetch(`${base}/api/auth/google`, { headers: { cookie: googleCookie! }, redirect: 'manual' });
    const googleRestartState = new URL(googleRestart.headers.get('location')!).searchParams.get('state');
    assert.ok(googleRestartState);
    const googleCallback = await fetch(`${base}/api/auth/google/callback?code=google-code&state=${encodeURIComponent(googleRestartState!)}`, {
      headers: { cookie: googleCookie! },
      redirect: 'manual',
    });
    assert.equal(googleCallback.status, 302);
    assert.match(googleCallback.headers.get('location') || '', /auth=google/);

    const googleMe = await fetch(`${base}/api/auth/me`, { headers: { cookie: googleCookie! } });
    assert.equal(googleMe.status, 200);
    const googleMeBody = await googleMe.json() as any;
    assert.equal(googleMeBody.authenticated, true);
    assert.equal(googleMeBody.provider, 'google');
    assert.equal(googleMeBody.githubConnected, false);
    assert.equal(googleMeBody.user.email, 'google@example.test');
    assert.equal(JSON.stringify(googleMeBody).includes('google-token'), false);

    const googleLogout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: googleCookie! } });
    assert.equal(googleLogout.status, 200);
    assert.match(googleLogout.headers.get('set-cookie') || '', /Max-Age=0/);
    const googleAfterLogout = await fetch(`${base}/api/auth/me`, { headers: { cookie: googleCookie! } });
    assert.equal(googleAfterLogout.status, 401);

    const start = await post(base, '/api/github/oauth/start', { sessionId: 's1' });
    assert.equal(start.status, 200);
    const callback = await post(base, '/api/github/oauth/callback', { sessionId: 's1', code: 'code', state: start.body.state });
    assert.equal(callback.status, 200);
    const queryOnlyMe = await fetch(`${base}/api/auth/me?sessionId=s1`);
    assert.equal(queryOnlyMe.status, 401);

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
