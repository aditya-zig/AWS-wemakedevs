import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Project, RepositoryRef } from '../../contracts/src/index.js';

export interface GitHubTransport {
  request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T>;
}

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
}

export interface RepositorySummary {
  fullName: string;
  url: string;
  defaultBranch: string;
}

export interface BranchSummary { name: string; commitSha: string; }
export interface GitHubUser {
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
}
export interface ImportRepositoryInput { fullName: string; branch?: string; name?: string; }

export class CredentialVault {
  #tokens = new Map<string, string>();
  set(sessionId: string, token: string): void { this.#tokens.set(sessionId, token); }
  get(sessionId: string): string | undefined { return this.#tokens.get(sessionId); }
  delete(sessionId: string): void { this.#tokens.delete(sessionId); }
  has(sessionId: string): boolean { return this.#tokens.has(sessionId); }
}

function statePayload(sessionId: string, issuedAt: number): string { return `${sessionId}.${issuedAt}`; }

export class GitHubOAuthService {
  constructor(
    private readonly config: GitHubOAuthConfig,
    private readonly transport: GitHubTransport,
    private readonly vault: CredentialVault,
  ) {}

  createAuthorizationUrl(sessionId: string): { authorizationUrl: string; state: string } {
    const issuedAt = Date.now();
    const payload = statePayload(sessionId, issuedAt);
    const signature = createHmac('sha256', this.config.stateSecret).update(payload).digest('base64url');
    const state = Buffer.from(`${payload}.${signature}`).toString('base64url');
    const params = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.callbackUrl, scope: 'repo read:user user:email', state });
    return { authorizationUrl: `https://github.com/login/oauth/authorize?${params.toString()}`, state };
  }

  private verifyState(sessionId: string, encodedState: string): void {
    let decoded = '';
    try { decoded = Buffer.from(encodedState, 'base64url').toString('utf8'); } catch { throw new Error('Invalid OAuth state'); }
    const parts = decoded.split('.');
    if (parts.length !== 3) throw new Error('Invalid OAuth state');
    const [storedSession, issuedAtText, signature] = parts;
    if (storedSession !== sessionId) throw new Error('OAuth state session mismatch');
    const issuedAt = Number(issuedAtText);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 10 * 60_000) throw new Error('OAuth state expired');
    const expected = createHmac('sha256', this.config.stateSecret).update(statePayload(storedSession, issuedAt)).digest();
    let actual: any;
    try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('Invalid OAuth state signature'); }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid OAuth state signature');
  }

  isAuthenticated(sessionId: string): boolean {
    return this.vault.has(sessionId);
  }

  async getAuthenticatedUser(sessionId: string): Promise<GitHubUser> {
    const token = this.vault.get(sessionId);
    if (!token) throw new Error('GitHub session is not authenticated');
    const user = await this.transport.request<{ login: string; name?: string | null; avatar_url?: string | null; email?: string | null }>('GET', '/user', undefined, token);
    return {
      login: user.login,
      ...(user.name ? { name: user.name } : {}),
      ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      ...(user.email ? { email: user.email } : {}),
    };
  }

  logout(sessionId: string): void {
    this.vault.delete(sessionId);
  }

  async handleCallback(sessionId: string, code: string, state: string): Promise<void> {
    this.verifyState(sessionId, state);
    const token = await this.transport.request<{ access_token?: string; error?: string }>('POST', '/login/oauth/access_token', {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.callbackUrl,
    });
    if (!token.access_token) throw new Error(`GitHub OAuth failed${token.error ? `: ${token.error}` : ''}`);
    this.vault.set(sessionId, token.access_token);
  }
}

export interface ProjectStore {
  save(project: Project): Promise<void> | void;
  get(id: string): Promise<Project | undefined> | Project | undefined;
}

export class MemoryProjectStore implements ProjectStore {
  #projects = new Map<string, Project>();
  save(project: Project): void { this.#projects.set(project.id, structuredClone(project)); }
  get(id: string): Project | undefined { const p = this.#projects.get(id); return p ? structuredClone(p) : undefined; }
  snapshot(): Project[] { return [...this.#projects.values()].map((p) => structuredClone(p)); }
}

export class JsonFileProjectStore implements ProjectStore {
  constructor(private readonly filePath: string) {}
  private async load(): Promise<Project[]> {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as Project[]; } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
  async save(project: Project): Promise<void> {
    const projects = await this.load();
    const next = projects.filter((item) => item.id !== project.id);
    next.push(project);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    await rename(temp, this.filePath);
  }
  async get(id: string): Promise<Project | undefined> { return (await this.load()).find((p) => p.id === id); }
}

function projectId(fullName: string, branch: string, commitSha: string): string {
  return `PRJ-${createHash('sha256').update(`${fullName}:${branch}:${commitSha}`).digest('hex').slice(0, 12).toUpperCase()}`;
}

export class RepositoryImportService {
  constructor(private readonly vault: CredentialVault, private readonly transport: GitHubTransport, private readonly store: ProjectStore) {}

  private token(sessionId: string): string {
    const token = this.vault.get(sessionId);
    if (!token) throw new Error('GitHub session is not authenticated');
    return token;
  }

  async listRepositories(sessionId: string): Promise<RepositorySummary[]> {
    const repos = await this.transport.request<Array<{ full_name: string; html_url: string; default_branch: string }>>('GET', '/user/repos', undefined, this.token(sessionId));
    return repos.map((repo) => ({ fullName: repo.full_name, url: repo.html_url, defaultBranch: repo.default_branch }));
  }

  async listBranches(sessionId: string, fullName: string): Promise<BranchSummary[]> {
    const branches = await this.transport.request<Array<{ name: string; commit: { sha: string } }>>('GET', `/repos/${fullName}/branches`, undefined, this.token(sessionId));
    return branches.map((branch) => ({ name: branch.name, commitSha: branch.commit.sha }));
  }

  async importRepository(sessionId: string, input: ImportRepositoryInput): Promise<Project> {
    const token = this.token(sessionId);
    const repos = await this.listRepositories(sessionId);
    const repo = repos.find((item) => item.fullName === input.fullName);
    if (!repo) throw new Error(`Repository ${input.fullName} is not accessible`);
    const branch = input.branch || repo.defaultBranch;
    const commit = await this.transport.request<{ sha: string }>('GET', `/repos/${input.fullName}/commits/${encodeURIComponent(branch)}`, undefined, token);
    const repository: RepositoryRef = { provider: 'github', fullName: repo.fullName, url: repo.url, defaultBranch: repo.defaultBranch };
    const project: Project = {
      id: projectId(repo.fullName, branch, commit.sha),
      name: input.name?.trim() || repo.fullName,
      repository,
      branch,
      commitSha: commit.sha,
      createdAt: new Date().toISOString(),
    };
    await this.store.save(project);
    return project;
  }
}

export class FetchGitHubTransport implements GitHubTransport {
  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const oauth = path === '/login/oauth/access_token';
    const url = oauth ? `https://github.com${path}` : `https://api.github.com${path}`;
    const headers: Record<string, string> = { accept: oauth ? 'application/json' : 'application/vnd.github+json', 'user-agent': 'VERIFIAI' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json() as any;
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${payload?.message || payload?.error || 'unknown error'}`);
    return payload as T;
  }
}
