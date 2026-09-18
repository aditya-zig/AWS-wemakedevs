import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AwsSecretsManagerCredentialSource,
  EnvironmentCredentialSource,
  MODEL_PROVIDER_PROFILES,
  SecretValue,
  publicModelRunSelection,
  redactProviderSecrets,
  resolveModelRunSelection,
  type CredentialSource,
} from '../services/agent-runtime/providers.js';

test('A02 exposes all approved OpenAI-compatible provider profiles', () => {
  assert.deepEqual(Object.keys(MODEL_PROVIDER_PROFILES).sort(), ['nvidia', 'ollama-cloud', 'openrouter']);
  assert.equal(MODEL_PROVIDER_PROFILES.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(MODEL_PROVIDER_PROFILES.nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(MODEL_PROVIDER_PROFILES['ollama-cloud'].baseUrl, 'https://ollama.com/v1');
});

test('one explicit provider/model is resolved per run without serializing its secret', async () => {
  const env = {
    VERIFIAI_MODEL_PROVIDER: 'nvidia',
    VERIFIAI_MODEL_ID: 'openai/gpt-oss-120b',
    NVIDIA_API_KEY: 'nv-secret-demo',
  };
  const selection = await resolveModelRunSelection({}, { env, environmentSource: new EnvironmentCredentialSource(env) });
  assert.equal(selection.profileId, 'nvidia:openai/gpt-oss-120b');
  assert.equal(selection.credential.reveal(), 'nv-secret-demo');
  assert.equal(JSON.stringify(selection).includes('nv-secret-demo'), false);
  assert.deepEqual(publicModelRunSelection(selection).credential, '[REDACTED]');
});

test('AWS Secrets Manager source uses injected SDK client and supports JSON fields', async () => {
  let requested = '';
  const source = new AwsSecretsManagerCredentialSource({
    client: {
      async send(command: any) {
        requested = command.input.SecretId;
        return { SecretString: JSON.stringify({ OPENROUTER_API_KEY: 'aws-managed-secret' }) };
      },
    },
  });
  const secret = await source.resolve({
    provider: 'openrouter',
    envName: 'OPENROUTER_API_KEY',
    awsSecretId: 'verifiai/demo/providers',
    awsSecretField: 'OPENROUTER_API_KEY',
  });
  assert.equal(requested, 'verifiai/demo/providers');
  assert.equal(secret.reveal(), 'aws-managed-secret');
  assert.equal(String(secret), '[REDACTED]');
});

test('run selection prefers AWS-managed secret when a secret id is configured', async () => {
  const fake: CredentialSource = {
    async resolve(request) {
      assert.equal(request.awsSecretId, 'verifiai/model-key');
      return new SecretValue('managed-key');
    },
  };
  const selection = await resolveModelRunSelection({
    provider: 'ollama-cloud',
    modelId: 'gpt-oss:120b-cloud',
    awsSecretId: 'verifiai/model-key',
  }, { env: {}, awsSource: fake });
  assert.equal(selection.credentialSource, 'aws-secrets-manager');
  assert.equal(selection.credential.reveal(), 'managed-key');
});

test('provider secret redaction is recursive and fail-closed', () => {
  const redacted = redactProviderSecrets({
    apiKey: 'raw-key',
    nested: { authorization: 'Bearer top-secret', note: 'safe top-secret' },
    wrapped: new SecretValue('wrapped-secret'),
  }, ['top-secret']);
  assert.deepEqual(redacted, {
    apiKey: '[REDACTED]',
    nested: { authorization: '[REDACTED]', note: 'safe [REDACTED]' },
    wrapped: '[REDACTED]',
  });
});
