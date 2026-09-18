import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecialistPolicy } from '../services/agents/specialist-policy.js';

test('A07 specialist policy grants real repository/API/performance/browser capabilities and bounded hosts', () => {
  const policy = buildSpecialistPolicy({
    modelProfileId: 'openrouter:model',
    target: { id: 'target', url: 'https://target.example', environment: 'shared-observation', immutable: true },
    computerUseUrl: 'https://cua.internal/run',
  });
  assert.ok(policy.approvedTools['security-secrets']?.[0].capabilities.includes('repository-read'));
  assert.ok(policy.approvedTools['browser-app-user']?.[0].capabilities.includes('computer-use'));
  assert.ok(policy.networkAllowlist.includes('openrouter.ai'));
  assert.ok(policy.networkAllowlist.includes('target.example'));
  assert.ok(policy.networkAllowlist.includes('cua.internal'));
  assert.equal(policy.inapplicable['browser-app-user'], undefined);
});

test('A07 marks app-user/API/performance lanes inapplicable when there is no runnable target', () => {
  const policy = buildSpecialistPolicy({ modelProfileId: 'nvidia:model', target: null });
  assert.match(policy.inapplicable['browser-app-user'] ?? '', /No runnable target/);
  assert.match(policy.inapplicable['api-chaos'] ?? '', /No runnable target/);
  assert.match(policy.inapplicable['performance-discovery'] ?? '', /No runnable target/);
});
