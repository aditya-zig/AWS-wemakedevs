import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type ModelProviderName = 'openrouter' | 'nvidia' | 'ollama-cloud';

export interface ModelProviderProfile {
  provider: ModelProviderName;
  baseUrl: string;
  apiKeyEnv: string;
  transport: 'openai-compatible';
}

export const MODEL_PROVIDER_PROFILES: Readonly<Record<ModelProviderName, ModelProviderProfile>> = Object.freeze({
  openrouter: {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    transport: 'openai-compatible',
  },
  nvidia: {
    provider: 'nvidia',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnv: 'NVIDIA_API_KEY',
    transport: 'openai-compatible',
  },
  'ollama-cloud': {
    provider: 'ollama-cloud',
    baseUrl: 'https://ollama.com/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    transport: 'openai-compatible',
  },
});

export class SecretValue {
  #value: string;
  constructor(value: string) {
    if (!value.trim()) throw new Error('secret value is empty');
    this.#value = value;
  }
  reveal(): string { return this.#value; }
  toString(): string { return '[REDACTED]'; }
  toJSON(): string { return '[REDACTED]'; }
}

export interface CredentialRequest {
  provider: ModelProviderName;
  envName: string;
  awsSecretId?: string;
  awsSecretField?: string;
}

export interface CredentialSource {
  resolve(request: CredentialRequest): Promise<SecretValue>;
}

export class EnvironmentCredentialSource implements CredentialSource {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async resolve(request: CredentialRequest): Promise<SecretValue> {
    const value = this.env[request.envName];
    if (!value) throw new Error(`Missing ${request.envName} for ${request.provider}`);
    return new SecretValue(value);
  }
}

export interface SecretsManagerLike {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }>;
}

export class AwsSecretsManagerCredentialSource implements CredentialSource {
  private readonly client: SecretsManagerLike;
  constructor(options: { client?: SecretsManagerLike; region?: string } = {}) {
    this.client = options.client ?? new SecretsManagerClient({ region: options.region ?? process.env.AWS_REGION ?? 'us-east-1' });
  }

  async resolve(request: CredentialRequest): Promise<SecretValue> {
    if (!request.awsSecretId) throw new Error('awsSecretId is required for AWS Secrets Manager credential source');
    const output = await this.client.send(new GetSecretValueCommand({ SecretId: request.awsSecretId }));
    let raw = output.SecretString;
    if (!raw && output.SecretBinary) raw = Buffer.from(output.SecretBinary).toString('utf8');
    if (!raw) throw new Error(`AWS secret ${request.awsSecretId} has no value`);
    if (request.awsSecretField) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error(`AWS secret ${request.awsSecretId} is not JSON`); }
      const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[request.awsSecretField] : undefined;
      if (typeof value !== 'string' || !value) throw new Error(`AWS secret field ${request.awsSecretField} is missing`);
      raw = value;
    }
    return new SecretValue(raw);
  }
}

export interface ModelRunSelectionInput {
  provider?: ModelProviderName;
  modelId?: string;
  baseUrl?: string;
  awsSecretId?: string;
  awsSecretField?: string;
}

export interface ResolvedModelRunSelection {
  profileId: string;
  provider: ModelProviderName;
  modelId: string;
  baseUrl: string;
  transport: 'openai-compatible';
  credential: SecretValue;
  credentialSource: 'environment' | 'aws-secrets-manager';
}

function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

export async function resolveModelRunSelection(
  input: ModelRunSelectionInput = {},
  options: {
    env?: Record<string, string | undefined>;
    environmentSource?: CredentialSource;
    awsSource?: CredentialSource;
  } = {},
): Promise<ResolvedModelRunSelection> {
  const env = options.env ?? process.env;
  const provider = input.provider ?? (env.VERIFIAI_MODEL_PROVIDER as ModelProviderName | undefined) ?? 'openrouter';
  const profile = MODEL_PROVIDER_PROFILES[provider];
  if (!profile) throw new Error(`Unsupported model provider: ${String(provider)}`);
  const modelId = required(input.modelId ?? env.VERIFIAI_MODEL_ID, 'VERIFIAI_MODEL_ID');
  const baseUrl = required(input.baseUrl ?? env.VERIFIAI_MODEL_BASE_URL ?? profile.baseUrl, 'model base URL');
  const awsSecretId = input.awsSecretId ?? env.VERIFIAI_MODEL_SECRET_ID;
  const awsSecretField = input.awsSecretField ?? env.VERIFIAI_MODEL_SECRET_FIELD;

  const request: CredentialRequest = { provider, envName: profile.apiKeyEnv, awsSecretId, awsSecretField };
  const credentialSource = awsSecretId ? 'aws-secrets-manager' : 'environment';
  const source = awsSecretId
    ? (options.awsSource ?? new AwsSecretsManagerCredentialSource({ region: env.AWS_REGION }))
    : (options.environmentSource ?? new EnvironmentCredentialSource(env));
  const credential = await source.resolve(request);

  return {
    profileId: `${provider}:${modelId}`,
    provider,
    modelId,
    baseUrl,
    transport: profile.transport,
    credential,
    credentialSource,
  };
}

export function publicModelRunSelection(selection: ResolvedModelRunSelection): Omit<ResolvedModelRunSelection, 'credential'> & { credential: '[REDACTED]' } {
  return { ...selection, credential: '[REDACTED]' };
}

export function redactProviderSecrets(value: unknown, secrets: readonly string[] = []): unknown {
  const explicit = secrets.filter(Boolean);
  const visit = (input: unknown, key = ''): unknown => {
    if (input instanceof SecretValue) return '[REDACTED]';
    if (typeof input === 'string') {
      let out = input;
      for (const secret of explicit) out = out.split(secret).join('[REDACTED]');
      if (/(api[_-]?key|secret|token|authorization|credential)/i.test(key)) return '[REDACTED]';
      return out;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item, key));
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, visit(v, k)]));
    }
    return input;
  };
  return visit(value);
}
