import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerRunSpec } from '../services/agent-runtime/docker-launcher.js';
import {
  AGENT_WORKER_CONTRACT_VERSION,
  type AgentWorkerLaunchBrief,
} from '../packages/contracts/src/index.js';

function brief(): AgentWorkerLaunchBrief {
  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: 'AUD-LOCAL-A04',
    workerId: 'W-SEC-LOCAL',
    role: 'security-secrets',
    objective: 'Exercise the same real worker contract locally.',
    repository: {
      provider: 'github',
      fullName: 'aditya-zig/AWS-wemakedevs',
      url: 'https://github.com/aditya-zig/AWS-wemakedevs',
      branch: 'main',
      commitSha: 'abc123',
    },
    target: null,
    tools: [],
    evidenceRefs: [],
    modelProfileId: 'openrouter:test-model',
    constraints: {
      timeoutMs: 60_000,
      maxToolCalls: 8,
      maxEvidenceItems: 20,
      destructiveAllowed: false,
      networkAllowlist: [],
      maxEstimatedSpendUsd: 0.25,
    },
  };
}

test('A04 local Docker worker enforces resource and privilege limits without embedding secrets', () => {
  const secret = 'unit-test-secret-never-in-args';
  const spec = buildDockerRunSpec(brief(), {
    env: {
      OPENROUTER_API_KEY: secret,
      VERIFIAI_LOCAL_WORKER_IMAGE: 'verifiai-agent-worker:test',
    },
    cpus: 0.75,
    memory: '768m',
    pidsLimit: 128,
    network: 'verifiai-local',
  });

  const joined = spec.args.join(' ');
  assert.match(joined, /--cpus 0\.75/);
  assert.match(joined, /--memory 768m/);
  assert.match(joined, /--pids-limit 128/);
  assert.match(joined, /--read-only/);
  assert.match(joined, /--cap-drop ALL/);
  assert.match(joined, /--security-opt no-new-privileges:true/);
  assert.match(joined, /--tmpfs \/tmp:rw,noexec,nosuid,size=64m/);
  assert.match(joined, /--network verifiai-local/);
  assert.ok(spec.forwardedEnvNames.includes('OPENROUTER_API_KEY'));
  assert.ok(!joined.includes(secret));
  assert.equal(spec.containerName, 'verifiai-AUD-LOCAL-A04-W-SEC-LOCAL');
});

test('A04 local Docker worker refuses to launch without model credentials', () => {
  assert.throws(
    () => buildDockerRunSpec(brief(), { env: {} }),
    /OPENROUTER_API_KEY or VERIFIAI_MODEL_SECRET_ID/,
  );
});
