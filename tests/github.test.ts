import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CredentialVault,
  GitHubOAuthService,
  MemoryProjectStore,
  RepositoryImportService,
  type GitHubTransport,
} from '../packages/core/github/index.js';

test('oauth state is validated and tokens stay out of stored project metadata', async () => {
  const transport: GitHubTransport = {
    async request(method, path, body) {
      if (path === '/login/oauth/access_token') return { access_token: 'secret-token' } as any;
      if (path === '/user') return { login: 'octocat', name: 'Octo Cat', avatar_url: 'https://example.test/octocat.png', email: 'octocat@example.test' } as any;
      if (path === '/user/repos') return [{ full_name: 'acme/shop', html_url: 'https://github.com/acme/shop', default_branch: 'main' }] as any;
      if (path === '/repos/acme/shop/branches') return [{ name: 'main', commit: { sha: 'abc123' } }] as any;
      if (path === '/repos/acme/shop/commits/main') return { sha: 'abc123' } as any;
      throw new Error(`unexpected ${method} ${path} ${JSON.stringify(body)}`);
    }
  };

  const vault = new CredentialVault();
  const oauth = new GitHubOAuthService({ clientId: 'client', clientSecret: 'client-secret', callbackUrl: 'https://verifiai.example/callback', stateSecret: 'state-secret' }, transport, vault);
  const { authorizationUrl, state } = oauth.createAuthorizationUrl('session-1');
  assert.ok(authorizationUrl.includes('client_id=client'));
  await oauth.handleCallback('session-1', 'code-123', state);
  assert.equal(vault.get('session-1'), 'secret-token');
  assert.equal(oauth.isAuthenticated('session-1'), true);
  assert.equal((await oauth.getAuthenticatedUser('session-1')).login, 'octocat');

  await assert.rejects(() => oauth.handleCallback('session-2', 'code-123', state), /state/i);

  const store = new MemoryProjectStore();
  const importer = new RepositoryImportService(vault, transport, store);
  const repos = await importer.listRepositories('session-1');
  assert.equal(repos[0].fullName, 'acme/shop');
  const project = await importer.importRepository('session-1', { fullName: 'acme/shop', branch: 'main', name: 'Shop verification' });
  assert.equal(project.commitSha, 'abc123');
  assert.equal(JSON.stringify(project).includes('secret-token'), false);
  assert.equal(JSON.stringify(store.snapshot()).includes('secret-token'), false);
  oauth.logout('session-1');
  assert.equal(oauth.isAuthenticated('session-1'), false);
});
