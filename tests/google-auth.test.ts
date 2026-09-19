import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuthService, type GoogleOAuthTransport } from '../packages/core/google/index.js';

test('google oauth validates one-time state, creates a user session, and never exposes the access token', async () => {
  const transport: GoogleOAuthTransport = {
    async exchangeCode(input) {
      assert.equal(input.clientId, 'google-client');
      assert.equal(input.clientSecret, 'google-secret');
      assert.equal(input.callbackUrl, 'https://verifiai.example/api/auth/google/callback');
      assert.equal(input.code, 'code-123');
      return { access_token: 'google-access-token' };
    },
    async fetchUser(accessToken) {
      assert.equal(accessToken, 'google-access-token');
      return {
        sub: 'google-user-1',
        email: 'user@example.test',
        name: 'Example User',
        picture: 'https://example.test/avatar.png',
        email_verified: true,
      };
    },
  };

  const oauth = new GoogleOAuthService({
    clientId: 'google-client',
    clientSecret: 'google-secret',
    callbackUrl: 'https://verifiai.example/api/auth/google/callback',
    stateSecret: 'state-secret',
  }, transport);

  const { authorizationUrl, state } = oauth.createAuthorizationUrl('session-1');
  const url = new URL(authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'google-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://verifiai.example/api/auth/google/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('scope') || '', /openid/);
  assert.equal(url.searchParams.get('state'), state);

  await oauth.handleCallback('session-1', 'code-123', state);
  assert.equal(oauth.isAuthenticated('session-1'), true);
  const user = oauth.getAuthenticatedUser('session-1');
  assert.equal(user.id, 'google-user-1');
  assert.equal(user.email, 'user@example.test');
  assert.equal(user.emailVerified, true);
  assert.equal(JSON.stringify(user).includes('google-access-token'), false);

  await assert.rejects(() => oauth.handleCallback('session-1', 'code-123', state), /state/i);

  const second = oauth.createAuthorizationUrl('session-2');
  await assert.rejects(() => oauth.handleCallback('wrong-session', 'code-123', second.state), /state/i);

  oauth.logout('session-1');
  assert.equal(oauth.isAuthenticated('session-1'), false);
  assert.throws(() => oauth.getAuthenticatedUser('session-1'), /not authenticated/i);
});
