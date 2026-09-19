import test from 'node:test';
import assert from 'node:assert/strict';
import { computerUseEvidenceOutcome } from '../services/agent-runtime/worker-tools.js';

test('Strands computer_use requires completed true before Cua can PASS', () => {
  const base = {
    ok: true,
    engine: 'Cua',
    upstreamCommit: '05f29785b508a4441ec3aa06c556a8e8b26c1d71',
  };

  assert.equal(computerUseEvidenceOutcome('cua', { ...base, completed: false }, true, true), 'unknown');
  assert.equal(computerUseEvidenceOutcome('cua', { ...base }, true, true), 'unknown');
  assert.equal(computerUseEvidenceOutcome('cua', { ...base, completed: true }, true, true), 'pass');
  assert.equal(computerUseEvidenceOutcome('cua', { ...base, completed: true, successful: false }, true, true), 'fail');
  assert.equal(computerUseEvidenceOutcome('cua', { ...base, completed: true }, true, false), 'unknown');
});
