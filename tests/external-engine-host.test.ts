import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('A07 AWS engine host is bounded, exact-commit and private to the auditor security group', async () => {
  const [stack, deploy, compose, e2e] = await Promise.all([
    readFile('infra/aws/external-engine-host.yml', 'utf8'),
    readFile('.github/workflows/deploy-external-engines.yml', 'utf8'),
    readFile('docker-compose.external.yml', 'utf8'),
    readFile('.github/workflows/real-repo-e2e.yml', 'utf8'),
  ]);

  assert.match(stack, /SourceCommit:/);
  assert.match(stack, /git -C \/opt\/verifiai checkout --detach "\$SOURCE_COMMIT"/);
  assert.match(stack, /test "\$\(git -C \/opt\/verifiai rev-parse HEAD\)" = "\$SOURCE_COMMIT"/);
  assert.match(stack, /Encrypted: true/);
  assert.match(stack, /MaxLifetimeMinutes:/);
  assert.match(stack, /shutdown -h \+\$\{MaxLifetimeMinutes\}/);
  assert.match(stack, /AmazonSSMManagedInstanceCore/);
  assert.match(stack, /secretsmanager:GetSecretValue/);
  assert.match(stack, /EngineSecretArn/);

  const ingressBlocks = [...stack.matchAll(/Type: AWS::EC2::SecurityGroupIngress[\s\S]*?(?=\n  [A-Z][A-Za-z0-9]+:|\nOutputs:)/g)].map((match) => match[0]);
  assert.ok(ingressBlocks.length >= 3);
  for (const block of ingressBlocks) {
    assert.doesNotMatch(block, /CidrIp:\s*0\.0\.0\.0\/0/);
    assert.match(block, /SourceSecurityGroupId:/);
  }

  assert.match(compose, /\$\{VERIFIAI_ENGINE_BIND:-127\.0\.0\.1\}:8789:8789/);
  assert.match(compose, /\$\{VERIFIAI_ENGINE_BIND:-127\.0\.0\.1\}:8791:8791/);
  assert.match(compose, /\$\{VERIFIAI_ENGINE_BIND:-127\.0\.0\.1\}:8792:8792/);

  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /action == 'destroy'/);
  assert.match(deploy, /aws cloudformation delete-stack/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:8789\/health/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:8791\/health/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:8792\/health/);
  assert.match(deploy, /SourceCommit=\$GITHUB_SHA/);

  assert.match(e2e, /VERIFIAI_ENGINE_STACK/);
  assert.match(e2e, /engine_output ExternalEngineUrl/);
  assert.match(e2e, /engine_output CuaUrl/);
  assert.match(e2e, /engine_output BrowserUseUrl/);
});
