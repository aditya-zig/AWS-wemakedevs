import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('A06 AWS security groups deny public HTTPS egress by default', async () => {
  const [targetStack, engineStack, targetDeploy, engineDeploy] = await Promise.all([
    readFile('infra/aws/real-target-stack.yml', 'utf8'),
    readFile('infra/aws/external-engine-host.yml', 'utf8'),
    readFile('.github/workflows/deploy-target-stack.yml', 'utf8'),
    readFile('.github/workflows/deploy-external-engines.yml', 'utf8'),
  ]);

  for (const stack of [targetStack, engineStack]) {
    assert.match(stack, /EnablePublicHttpsEgress:/);
    assert.match(stack, /Default: 'false'/);
    assert.match(stack, /PublicHttpsEgressEnabled: !Equals \[!Ref EnablePublicHttpsEgress, 'true'\]/);
    assert.match(stack, /- !If\n\s+- PublicHttpsEgressEnabled[\s\S]*?CidrIp: 0\.0\.0\.0\/0[\s\S]*?- !Ref AWS::NoValue/);
  }

  assert.match(targetDeploy, /VERIFIAI_ENABLE_PUBLIC_HTTPS_EGRESS: \$\{\{ vars\.VERIFIAI_ENABLE_PUBLIC_HTTPS_EGRESS \|\| 'false' \}\}/);
  assert.match(targetDeploy, /EnablePublicHttpsEgress="\$VERIFIAI_ENABLE_PUBLIC_HTTPS_EGRESS"/);

  assert.match(engineDeploy, /VERIFIAI_ENABLE_ENGINE_PUBLIC_HTTPS_EGRESS: \$\{\{ vars\.VERIFIAI_ENABLE_ENGINE_PUBLIC_HTTPS_EGRESS \|\| 'false' \}\}/);
  assert.match(engineDeploy, /VERIFIAI_ENABLE_ENGINE_PUBLIC_HTTPS_EGRESS=true/);
  assert.match(engineDeploy, /EnablePublicHttpsEgress=\$VERIFIAI_ENABLE_ENGINE_PUBLIC_HTTPS_EGRESS/);
});
