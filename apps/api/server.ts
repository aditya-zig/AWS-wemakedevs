import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { GitHubOAuthService, RepositoryImportService } from '../../packages/core/github/index.js';
import { buildVerificationPlan, parseRequirements } from '../../packages/core/planning/index.js';
import type { Experiment } from '../../packages/contracts/src/index.js';
import type { RunService } from './runs/service.js';

export interface ApiDependencies { oauth: GitHubOAuthService; importer: RepositoryImportService; runs?: RunService; }

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

export function createApiServer(deps: ApiDependencies): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return respond(response, 200, { ok: true, service: 'verifiai-api' });

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
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return respond(response, 400, { error: 'sessionId is required' });
        return respond(response, 200, { repositories: await deps.importer.listRepositories(sessionId) });
      }
      const branchRoute = url.pathname.match(/^\/api\/github\/repositories\/([^/]+)\/([^/]+)\/branches$/);
      if (request.method === 'GET' && branchRoute) {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) return respond(response, 400, { error: 'sessionId is required' });
        const fullName = `${decodeURIComponent(branchRoute[1])}/${decodeURIComponent(branchRoute[2])}`;
        return respond(response, 200, { branches: await deps.importer.listBranches(sessionId, fullName) });
      }
      if (request.method === 'POST' && url.pathname === '/api/projects/import') {
        const body = await readJson(request);
        if (typeof body.sessionId !== 'string' || typeof body.fullName !== 'string') return respond(response, 400, { error: 'sessionId and fullName are required' });
        const project = await deps.importer.importRepository(body.sessionId, { fullName: body.fullName, branch: body.branch, name: body.name });
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
