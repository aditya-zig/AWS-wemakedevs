import { join } from 'node:path';
import { createApiServer } from './server.js';
import { RunService } from './runs/service.js';
import { CredentialVault, FetchGitHubTransport, GitHubOAuthService, JsonFileProjectStore, RepositoryImportService } from '../../packages/core/github/index.js';
import { FetchGoogleOAuthTransport, GoogleOAuthService } from '../../packages/core/google/index.js';
import { VerificationOrchestrator } from '../../packages/core/orchestrator/index.js';
import { LiveAuditService } from './swarms/service.js';
import { LiveRepairService } from './repairs/service.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.VERIFIAI_DATA_DIR || './data';
const webUrl = process.env.VERIFIAI_WEB_URL || 'http://localhost:4173';
const secureCookies = process.env.VERIFIAI_SECURE_COOKIES === 'true' || webUrl.startsWith('https://');
const transport = new FetchGitHubTransport();
const vault = new CredentialVault();
const oauth = new GitHubOAuthService({
  clientId: required('GITHUB_CLIENT_ID'),
  clientSecret: required('GITHUB_CLIENT_SECRET'),
  callbackUrl: required('GITHUB_CALLBACK_URL'),
  stateSecret: required('VERIFIAI_STATE_SECRET'),
}, transport, vault);
const googleOauth = new GoogleOAuthService({
  clientId: required('GOOGLE_CLIENT_ID'),
  clientSecret: required('GOOGLE_CLIENT_SECRET'),
  callbackUrl: required('GOOGLE_CALLBACK_URL'),
  stateSecret: required('VERIFIAI_STATE_SECRET'),
}, new FetchGoogleOAuthTransport());
const importer = new RepositoryImportService(vault, transport, new JsonFileProjectStore(join(dataDir, 'projects.json')));

// Adapter-owned tools are injected here during integration. Missing tools resolve to UNKNOWN, never false PASS.
const runs = new RunService(new VerificationOrchestrator(new Map()));
const swarms = new LiveAuditService();
const repairs = new LiveRepairService();
const server = createApiServer({ oauth, googleOauth, importer, runs, swarms, repairs, webUrl, secureCookies });
server.listen(port, '0.0.0.0', () => console.log(`VERIFAI API listening on :${port}`));
