import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('A11/A12 real-repo contract targets Twenty and Cal.diy only', async () => {
  const candidates = JSON.parse(await readFile('config/e2e-repositories.json', 'utf8'));
  assert.deepEqual(candidates.map((candidate: any) => candidate.id), ['twenty', 'cal-diy']);

  const twenty = candidates[0];
  assert.equal(twenty.fullName, 'twentyhq/twenty');
  assert.equal(twenty.branch, 'main');
  assert.equal(twenty.dockerfile, 'packages/twenty-docker/twenty/Dockerfile');
  assert.equal(twenty.buildTarget, 'twenty-app-dev');
  assert.equal(twenty.containerPort, 2020);
  assert.equal(twenty.healthPath, '/healthz');
  assert.equal(twenty.runtimeEnvironment.LOGIC_FUNCTION_TYPE, 'DISABLED');
  assert.equal(twenty.runtimeEnvironment.CODE_INTERPRETER_TYPE, 'DISABLED');

  const cal = candidates[1];
  assert.equal(cal.fullName, 'calcom/cal.diy');
  assert.equal(cal.branch, 'main');
  assert.equal(cal.dockerfile, 'Dockerfile');
  assert.equal(cal.containerPort, 3000);
  assert.equal(cal.healthPath, '/auth/login');
  assert.equal(cal.sidecars.length, 1);
  assert.equal(cal.sidecars[0].sourceImage, 'public.ecr.aws/docker/library/postgres:16-alpine');
  assert.equal(cal.sidecars[0].mirrorToTargetEcr, true);
  assert.equal(cal.sidecars[0].environment.POSTGRES_HOST_AUTH_METHOD, 'trust');

  const serialized = JSON.stringify(candidates);
  assert.doesNotMatch(serialized, /juice-shop|welcome-to-docker|traefik\/whoami/);
});

test('A12 manual demo runner supports both required real candidates with bounded repetitions', async () => {
  const workflow = await readFile('.github/workflows/real-repo-e2e.yml', 'utf8');
  assert.match(workflow, /default: twenty/);
  assert.match(workflow, /- twenty/);
  assert.match(workflow, /- cal-diy/);
  assert.match(workflow, /- all/);
  assert.match(workflow, /repeat_count:/);
  assert.match(workflow, /repositories=\(twenty cal-diy\)/);
  assert.match(workflow, /repeat_count must stay between 1 and 2/);
  assert.match(workflow, /VERIFIAI_E2E_OUTPUT_DIR="artifacts\/real-repo-e2e\/\$repository\/run-\$attempt"/);
  assert.match(workflow, /if: always\(\)/);
});
