import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('A12 manual demo runner supports all real candidates with bounded repetitions', async () => {
  const workflow = await readFile('.github/workflows/real-repo-e2e.yml', 'utf8');
  assert.match(workflow, /- all/);
  assert.match(workflow, /repeat_count:/);
  assert.match(workflow, /repositories=\(owasp-juice-shop docker-welcome traefik-whoami\)/);
  assert.match(workflow, /repeat_count must stay between 1 and 2/);
  assert.match(workflow, /VERIFIAI_E2E_OUTPUT_DIR="artifacts\/real-repo-e2e\/\$repository\/run-\$attempt"/);
  assert.match(workflow, /if: always\(\)/);
});
