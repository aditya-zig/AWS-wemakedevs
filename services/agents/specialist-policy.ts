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

  const approvedTools: SpecialistPolicy['approvedTools'] = {
    'security-secrets': [{
      name: 'repository',
      capabilities: ['repository-read', 'source-inspection', 'security-analysis'],
      executionClass: 'agent-native',
    }],
    'api-chaos': [{
      name: 'api',
      capabilities: ['http-request', 'api-probe', 'bounded-chaos'],
      executionClass: 'agent-native',
    }],
    'performance-discovery': [{
      name: 'performance',
      capabilities: ['http-request', 'performance-probe', 'discovery'],
      executionClass: 'agent-native',
    }],
    hypothesis: [{
      name: 'repository',
      capabilities: ['repository-read', 'source-inspection'],
      executionClass: 'agent-native',
    }],
    investigator: [{
      name: 'investigation',
      capabilities: ['repository-read', 'http-request', 'performance-probe'],
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
      capabilities: ['browser-interact', 'computer-use'],
      executionClass: 'agent-native',
    }];
  } else {
    inapplicable['browser-app-user'] = 'No runnable target URL is available.';
  }
  if (!input.target?.url) {
    inapplicable['api-chaos'] = 'No runnable target URL is available.';
    inapplicable['performance-discovery'] = 'No runnable target URL is available.';
  }
  if (!input.computerUseUrl && input.target?.url) {
    inapplicable['browser-app-user'] = 'Computer-use service is not configured for real app interaction.';
  }

  return { approvedTools, networkAllowlist: [...networkAllowlist], inapplicable };
}
