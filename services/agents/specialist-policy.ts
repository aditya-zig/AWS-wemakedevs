import type {
  AgentToolGrant,
  AgentWorkerRole,
  AuditTargetRef,
} from '../../packages/contracts/src/index.js';
import { MODEL_PROVIDER_PROFILES, type ModelProviderName } from '../agent-runtime/providers.js';

export interface SpecialistPolicy {
  approvedTools: Partial<Record<AgentWorkerRole, AgentToolGrant[]>>;
  networkAllowlist: string[];
  inapplicable: Partial<Record<AgentWorkerRole, string>>;
}

function host(url: string): string {
  return new URL(url).hostname;
}

export function buildSpecialistPolicy(input: {
  modelProfileId: string;
  target: AuditTargetRef | null;
  computerUseUrl?: string;
  browserUseUrl?: string;
  cuaUrl?: string;
  externalEngineUrl?: string;
}): SpecialistPolicy {
  const provider = input.modelProfileId.split(':', 1)[0] as ModelProviderName;
  const profile = MODEL_PROVIDER_PROFILES[provider];
  if (!profile) throw new Error(`Unsupported model provider profile: ${provider}`);

  const networkAllowlist = new Set<string>([
    host(profile.baseUrl),
    'api.github.com',
    'raw.githubusercontent.com',
  ]);
  if (input.target?.url) networkAllowlist.add(host(input.target.url));
  if (input.computerUseUrl) networkAllowlist.add(host(input.computerUseUrl));
  if (input.browserUseUrl) networkAllowlist.add(host(input.browserUseUrl));
  if (input.cuaUrl) networkAllowlist.add(host(input.cuaUrl));
  if (input.externalEngineUrl) networkAllowlist.add(host(input.externalEngineUrl));

  const approvedTools: SpecialistPolicy['approvedTools'] = {
    'security-secrets': [{
      name: 'repository',
      capabilities: ['repository-read', 'source-inspection', 'security-analysis', 'strix'],
      executionClass: 'agent-native',
    }],
    'api-chaos': [{
      name: 'api',
      capabilities: ['http-request', 'api-probe', 'schemathesis', 'bounded-chaos', 'toxiproxy'],
      executionClass: 'agent-native',
    }],
    'performance-discovery': [{
      name: 'performance',
      capabilities: ['http-request', 'performance-probe', 'locust', 'k6', 'load', 'discovery'],
      executionClass: 'agent-native',
    }],
    hypothesis: [{
      name: 'repository',
      capabilities: ['repository-read', 'source-inspection'],
      executionClass: 'agent-native',
    }],
    investigator: [{
      name: 'investigation',
      capabilities: ['repository-read', 'http-request', 'performance-probe', 'schemathesis', 'strix', 'locust', 'k6'],
      executionClass: 'agent-native',
    }],
    judge: [{
      name: 'judge',
      capabilities: ['repository-read', 'http-request'],
      executionClass: 'agent-native',
    }],
    reverification: [{
      name: 'reverification',
      capabilities: ['repository-read', 'http-request', 'performance-probe'],
      executionClass: 'agent-native',
    }],
  };

  const inapplicable: SpecialistPolicy['inapplicable'] = {};
  if (input.target?.url) {
    approvedTools['browser-app-user'] = [{
      name: 'browser',
      capabilities: ['browser-interact', 'computer-use', 'browser-use', 'cua'],
      executionClass: 'agent-native',
    }];
  } else {
    inapplicable['browser-app-user'] = 'No runnable target URL is available.';
  }
  if (!input.target?.url) {
    inapplicable['api-chaos'] = 'No runnable target URL is available.';
    inapplicable['performance-discovery'] = 'No runnable target URL is available.';
  }
  if (!input.computerUseUrl && !input.browserUseUrl && !input.cuaUrl && input.target?.url) {
    inapplicable['browser-app-user'] = 'Browser Use/Cua computer-use service is not configured for real app interaction.';
  }

  return { approvedTools, networkAllowlist: [...networkAllowlist], inapplicable };
}
