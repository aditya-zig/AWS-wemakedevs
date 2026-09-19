import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('hackathon AWS cost and lifetime guardrails stay hard-coded', async () => {
  const [target, agentcore, agentcoreDeploy, e2e, workflow, cua, mirofish, swarms] = await Promise.all([
    readFile('infra/aws/real-target-stack.yml', 'utf8'),
    readFile('infra/aws/agentcore-runtime.yml', 'utf8'),
    readFile('.github/workflows/deploy-agentcore.yml', 'utf8'),
    readFile('scripts/real-repo-e2e.mjs', 'utf8'),
    readFile('.github/workflows/real-repo-e2e.yml', 'utf8'),
    readFile('services/cua-runner/server.py', 'utf8'),
    readFile('packages/adapters/mirofish/index.mjs', 'utf8'),
    readFile('apps/api/swarms/service.ts', 'utf8'),
  ]);

  assert.match(target, /Cpu: '512'/);
  assert.match(target, /Memory: '1024'/);
  assert.match(target, /"countNumber":3/);
  assert.equal((target.match(/RetentionInDays: 7/g) ?? []).length, 2);
  assert.match(target, /ExpirationInDays: 7/);

  assert.match(agentcore, /MaxLifetime: 1200/);
  assert.match(agentcoreDeploy, /"countNumber":3/);
  assert.match(cua, /"max_retries": 1/);
  assert.match(mirofish, /Math\.min\(Number\(config\.parallelProfileCount \?\? 5\), 5\)/);
  assert.match(swarms, /VERIFIAI_MAX_WORKER_RETRIES \?\? 1/);
  assert.match(swarms, /AWS_REGION \?\? 'ap-south-1'/);

  assert.match(e2e, /Math\.min\(Number\(process\.env\.VERIFIAI_E2E_TIMEOUT_MS \|\| 20 \* 60_000\), 20 \* 60_000\)/);
  assert.match(workflow, /group: verifiai-fargate-target/);
  assert.match(workflow, /Emergency exact-task teardown/);
  assert.match(workflow, /aws ecs stop-task/);
  assert.match(workflow, /AWS_REGION: \$\{\{ vars\.AWS_REGION \|\| 'ap-south-1' \}\}/);
});
