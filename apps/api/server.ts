import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { GitHubOAuthService, RepositoryImportService } from '../../packages/core/github/index.js';
import { buildVerificationPlan, parseRequirements } from '../../packages/core/planning/index.js';
import type { Experiment } from '../../packages/contracts/src/index.js';
import type { RunService } from './runs/service.js';

export interface ApiDependencies {
  oauth: GitHubOAuthService;
  importer: RepositoryImportService;
  runs?: RunService;
  webUrl?: string;
  secureCookies?: boolean;
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: any[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
function respond(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}
function validRequirements(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

const SESSION_COOKIE = 'verifiai_session';

function cookies(request: IncomingMessage): Record<string, string> {
  const raw = request.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map((part: string) => part.trim()).filter(Boolean).map((part: string) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}
function sessionId(request: IncomingMessage, url?: URL, body?: any): string | undefined {
  return cookies(request)[SESSION_COOKIE] || url?.searchParams.get('sessionId') || (typeof body?.sessionId === 'string' ? body.sessionId : undefined) || undefined;
}
function setSessionCookie(response: ServerResponse, value: string, secure: boolean): void {
  response.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
}
function clearSessionCookie(response: ServerResponse, secure: boolean): void {
  response.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}
function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('location', location);
  response.setHeader('cache-control', 'no-store');
  response.end();
}
function authenticatedWebUrl(webUrl: string): string {
  const target = new URL(webUrl);
  target.searchParams.set('auth', 'github');
  target.hash = '/repository';
  return target.toString();
}
function applyCors(request: IncomingMessage, response: ServerResponse, webUrl: string): void {
  const origin = request.headers.origin;
  const allowedOrigin = new URL(webUrl).origin;
  if (origin === allowedOrigin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('access-control-allow-credentials', 'true');
    response.setHeader('vary', 'Origin');
  }
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
}

export function createApiServer(deps: ApiDependencies): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      const webUrl = deps.webUrl || 'http://localhost:4173';
      const secureCookies = deps.secureCookies ?? webUrl.startsWith('https://');
      applyCors(request, response, webUrl);
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/health') return respond(response, 200, { ok: true, service: 'verifiai-api' });

      if (request.method === 'GET' && url.pathname === '/api/auth/github') {
        const id = sessionId(request, url) || randomUUID();
        const { authorizationUrl } = deps.oauth.createAuthorizationUrl(id);
        setSessionCookie(response, id, secureCookies);
        return redirect(response, authorizationUrl);
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/github/callback') {
        const id = sessionId(request, url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!id || !code || !state) return respond(response, 400, { error: 'GitHub callback is missing session, code or state' });
        await deps.oauth.handleCallback(id, code, state);
        return redirect(response, authenticatedWebUrl(webUrl));
      }
      if (request.method === 'GET' && url.pathname === '/api/auth/me') {
        const id = sessionId(request, url);
        if (!id || !deps.oauth.isAuthenticated(id)) return respond(response, 401, { authenticated: false });
        return respond(response, 200, { authenticated: true, provider: 'github', user: await deps.oauth.getAuthenticatedUser(id) });
      }
      if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
        const id = sessionId(request, url);
        if (id) deps.oauth.logout(id);
        clearSessionCookie(response, secureCookies);
        return respond(response, 200, { authenticated: false });
      }

      if (request.method === 'POST' && url.pathname === '/api/github/oauth/start') {
        const body = await readJson(request);
        if (typeof body.sessionId !== 'string' || !body.sessionId) return respond(response, 400, { error: 'sessionId is required' });
        return respond(response, 200, deps.oauth.createAuthorizationUrl(body.sessionId));
      }
      if (request.method === 'POST' && url.pathname === '/api/github/oauth/callback') {
        const body = await readJson(request);
        if (![body.sessionId, body.code, body.state].every((item) => typeof item === 'string' && item)) return respond(response, 400, { error: 'sessionId, code and state are required' });
        await deps.oauth.handleCallback(body.sessionId, body.code, body.state);
        return respond(response, 200, { connected: true });
      }
      if (request.method === 'GET' && url.pathname === '/api/github/repositories') {
        const id = sessionId(request, url);
        if (!id) return respond(response, 401, { error: 'GitHub authentication is required' });
        return respond(response, 200, { repositories: await deps.importer.listRepositories(id) });
      }
      const branchRoute = url.pathname.match(/^\/api\/github\/repositories\/([^/]+)\/([^/]+)\/branches$/);
      if (request.method === 'GET' && branchRoute) {
        const id = sessionId(request, url);
        if (!id) return respond(response, 401, { error: 'GitHub authentication is required' });
        const fullName = `${decodeURIComponent(branchRoute[1])}/${decodeURIComponent(branchRoute[2])}`;
        return respond(response, 200, { branches: await deps.importer.listBranches(id, fullName) });
      }
      if (request.method === 'POST' && url.pathname === '/api/projects/import') {
        const body = await readJson(request);
        const id = sessionId(request, url, body);
        if (!id || typeof body.fullName !== 'string') return respond(response, 400, { error: 'authenticated session and fullName are required' });
        const project = await deps.importer.importRepository(id, { fullName: body.fullName, branch: body.branch, name: body.name });
        return respond(response, 201, { project });
      }
      if (request.method === 'POST' && url.pathname === '/api/requirements/parse') {
        const body = await readJson(request);
        if (!validRequirements(body.requirements)) return respond(response, 400, { error: 'requirements must be a non-empty string array' });
        return respond(response, 200, { requirements: parseRequirements(body.requirements) });
      }
      if (request.method === 'POST' && url.pathname === '/api/plans') {
        const body = await readJson(request);
        if (!validRequirements(body.requirements)) return respond(response, 400, { error: 'requirements must be a non-empty string array' });
        const requirements = parseRequirements(body.requirements);
        return respond(response, 200, { requirements, experiments: buildVerificationPlan(requirements) });
      }

      if (request.method === 'POST' && url.pathname === '/api/runs') {
        if (!deps.runs) return respond(response, 503, { error: 'run service unavailable' });
        const body = await readJson(request);
        if (typeof body.projectId !== 'string' || !Array.isArray(body.experiments)) return respond(response, 400, { error: 'projectId and experiments are required' });
        const run = await deps.runs.start(body.projectId, body.experiments as Experiment[]);
        return respond(response, 201, { run });
      }
      const runEvents = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (request.method === 'GET' && runEvents) {
        if (!deps.runs) return respond(response, 503, { error: 'run service unavailable' });
        const run = deps.runs.get(runEvents[1]);
        if (!run) return respond(response, 404, { error: 'run not found' });
        return respond(response, 200, { events: deps.runs.events(runEvents[1]) });
      }
      const runById = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (request.method === 'GET' && runById) {
        if (!deps.runs) return respond(response, 503, { error: 'run service unavailable' });
        const run = deps.runs.get(runById[1]);
        return run ? respond(response, 200, { run }) : respond(response, 404, { error: 'run not found' });
      }
      return respond(response, 404, { error: 'not found' });
    } catch (error: any) {
      return respond(response, 400, { error: String(error?.message || error) });
    }
  });
}
