import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirements, buildVerificationPlan } from '../packages/core/planning/index.js';

test('requirements become stable structured requirements and deterministic experiments', () => {
  const input = [
    'If the payment provider becomes unavailable, checkout must fail gracefully and preserve the user cart.',
    'The health API should respond successfully.',
    'Expired authentication must not allow protected actions.'
  ];

  const first = parseRequirements(input);
  const second = parseRequirements(input);
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.match(first[0].id, /^REQ-/);
  assert.ok(first[0].invariants.some((value) => value.includes('cart')));
  assert.ok(first[0].experimentTypes.includes('chaos'));
  assert.ok(first[2].targetTools.includes('security'));

  const plan = buildVerificationPlan(first);
  assert.ok(plan.length >= 5);
  assert.ok(plan.every((experiment) => experiment.status === 'pending'));
  assert.deepEqual(plan, buildVerificationPlan(second));
});
