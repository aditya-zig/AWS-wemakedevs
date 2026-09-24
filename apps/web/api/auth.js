const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');

const SESSION_COOKIE = 'verifiai_session';
const OAUTH_COOKIE = 'verifiai_oauth';
const TEN_MINUTES = 10 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function webUrl() {
  return (process.env.VERIFIAI_WEB_URL || 'https://verifai-green.vercel.app').replace(/\/$/, '');
}

function parseCookies(request) {
  const raw = request.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? [part, ''] : [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
    })
  );
}

function appendCookie(response, value) {
  const current = response.getHeader('Set-Cookie');
  const next = current ? (Array.isArray(current) ? [...current, value] : [current, value]) : [value];
  response.setHeader('Set-Cookie', next);
}

function setCookie(response, name, value, maxAge) {
  appendCookie(response, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearCookie(response, name) {
  appendCookie(response, `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function hmac(value) {
  return createHmac('sha256', required('VERIFIAI_STATE_SECRET')).update(value).digest('base64url');
}

function signState(provider, nonce) {
  const issuedAt = Date.now();
  const payload = `${provider}.${nonce}.${issuedAt}`;
  return Buffer.from(`${payload}.${hmac(payload)}`).toString('base64url');
}

function verifyState(provider, nonce, encoded) {
  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid OAuth state');
  }
  const parts = decoded.split('.');
  if (parts.length !== 4) throw new Error('Invalid OAuth state');
  const [storedProvider, storedNonce, issuedAtText, signature] = parts;
  if (storedProvider !== provider || storedNonce !== nonce) throw new Error('OAuth state mismatch');
  const issuedAt = Number(issuedAtText);
  if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > TEN_MINUTES) throw new Error('OAuth state expired');
  const payload = `${storedProvider}.${storedNonce}.${issuedAt}`;
  const expected = Buffer.from(hmac(payload), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid OAuth state signature');
}

function encodeSession(value) {
  const payload = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + ONE_DAY * 1000 })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function decodeSession(value) {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = Buffer.from(hmac(payload), 'base64url');
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session?.exp || Date.now() > session.exp) return null;
    return session;
  } catch {
    return null;
  }
}

function redirect(response, location) {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function callbackRedirect(provider) {
  return `${webUrl()}/?auth=${provider}#/repository`;
}

async function githubStart(response) {
  const nonce = randomUUID();
  const state = signState('github', nonce);
  setCookie(response, OAUTH_COOKIE, `github.${nonce}`, 600);
  const params = new URLSearchParams({
    client_id: required('GITHUB_CLIENT_ID'),
    redirect_uri: required('GITHUB_CALLBACK_URL'),
    scope: 'read:user user:email',
    state,
  });
  redirect(response, `https://github.com/login/oauth/authorize?${params.toString()}`);
}

async function githubCallback(request, response, url) {
  const oauthCookie = parseCookies(request)[OAUTH_COOKIE] || '';
  const [provider, nonce] = oauthCookie.split('.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (provider !== 'github' || !nonce || !code || !state) throw new Error('GitHub callback is missing session, code or state');
  verifyState('github', nonce, state);

  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'VERIFAI' },
    body: JSON.stringify({
      client_id: required('GITHUB_CLIENT_ID'),
      client_secret: required('GITHUB_CLIENT_SECRET'),
      code,
      redirect_uri: required('GITHUB_CALLBACK_URL'),
    }),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) throw new Error(`GitHub OAuth failed${token?.error ? `: ${token.error}` : ''}`);

  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.access_token}`,
      'user-agent': 'VERIFAI',
    },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user?.login) throw new Error('GitHub user profile could not be loaded');

  setCookie(response, SESSION_COOKIE, encodeSession({
    provider: 'github',
    user: {
      login: user.login,
      ...(user.name ? { name: user.name } : {}),
      ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      ...(user.email ? { email: user.email } : {}),
    },
  }), ONE_DAY);
  clearCookie(response, OAUTH_COOKIE);
  redirect(response, callbackRedirect('github'));
}

async function googleStart(response) {
  const nonce = randomUUID();
  const state = signState('google', nonce);
  setCookie(response, OAUTH_COOKIE, `google.${nonce}`, 600);
  const params = new URLSearchParams({
    client_id: required('GOOGLE_CLIENT_ID'),
    redirect_uri: required('GOOGLE_CALLBACK_URL'),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    include_granted_scopes: 'true',
  });
  redirect(response, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function googleCallback(request, response, url) {
  const oauthCookie = parseCookies(request)[OAUTH_COOKIE] || '';
  const [provider, nonce] = oauthCookie.split('.');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (provider !== 'google' || !nonce || !code || !state) throw new Error('Google callback is missing session, code or state');
  verifyState('google', nonce, state);

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required('GOOGLE_CLIENT_ID'),
      client_secret: required('GOOGLE_CLIENT_SECRET'),
      code,
      grant_type: 'authorization_code',
      redirect_uri: required('GOOGLE_CALLBACK_URL'),
    }).toString(),
  });
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || !token.access_token) {
    throw new Error(`Google token exchange failed (${tokenResponse.status}): ${token?.error_description || token?.error || 'unknown error'}`);
  }

  const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { accept: 'application/json', authorization: `Bearer ${token.access_token}` },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user?.sub || !user?.email) throw new Error('Google user profile could not be loaded');

  setCookie(response, SESSION_COOKIE, encodeSession({
    provider: 'google',
    user: {
      id: user.sub,
      email: user.email,
      ...(user.name ? { name: user.name } : {}),
      ...(user.picture ? { avatarUrl: user.picture } : {}),
      ...(typeof user.email_verified === 'boolean' ? { emailVerified: user.email_verified } : {}),
    },
  }), ONE_DAY);
  clearCookie(response, OAUTH_COOKIE);
  redirect(response, callbackRedirect('google'));
}

module.exports = async function handler(request, response) {
  try {
    const url = new URL(request.url || '/', 'https://verifai.invalid');
    const path = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    if (request.method === 'GET' && path === 'github') return githubStart(response);
    if (request.method === 'GET' && path === 'github/callback') return githubCallback(request, response, url);
    if (request.method === 'GET' && path === 'google') return googleStart(response);
    if (request.method === 'GET' && path === 'google/callback') return googleCallback(request, response, url);

    if (request.method === 'GET' && path === 'me') {
      const session = decodeSession(parseCookies(request)[SESSION_COOKIE]);
      if (!session) return json(response, 401, { authenticated: false });
      return json(response, 200, {
        authenticated: true,
        provider: session.provider,
        githubConnected: session.provider === 'github',
        user: session.user,
      });
    }

    if (request.method === 'POST' && path === 'logout') {
      clearCookie(response, SESSION_COOKIE);
      clearCookie(response, OAUTH_COOKIE);
      return json(response, 200, { authenticated: false });
    }

    return json(response, 404, { error: 'not found' });
  } catch (error) {
    return json(response, 400, { error: String(error?.message || error) });
  }
}
