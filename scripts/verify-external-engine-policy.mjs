#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(root, 'config/external-engines.json'), 'utf8'));

const violations = [
  {
    file: 'packages/adapters/strix/index.mjs',
    patterns: ['strix-fallback', 'Strix-compatible fallback'],
    reason: 'Strix must execute the real upstream runtime.',
  },
  {
    file: 'packages/adapters/cua/index.mjs',
    patterns: ['cua-fallback', 'Cua-compatible fallback', 'synthetic: true'],
    reason: 'Cua evidence must come from the real Cua runtime.',
  },
  {
    file: 'packages/adapters/mirofish/index.mjs',
    patterns: ['bounded-fixture', 'simulatedFailures'],
    reason: 'MiroFish persona outcomes must come from the real MiroFish simulation pipeline.',
  },
  {
    file: 'services/deep-audit/index.mjs',
    patterns: ["source: 'sandbox-chaos'", "injectFault(runId"],
    reason: 'An in-memory fault record is not Toxiproxy/network fault execution evidence.',
  },
];

let failed = false;

for (const engine of manifest.engines) {
  if (!engine.repo || !engine.commit || !engine.license || !engine.boundary || !engine.runtimeStrategy) {
    console.error(`POLICY FAIL manifest entry incomplete: ${engine.id}`);
    failed = true;
  }
}

for (const check of violations) {
  const path = join(root, check.file);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  const found = check.patterns.filter((pattern) => text.includes(pattern));
  if (!found.length) continue;
  failed = true;
  console.error(`POLICY FAIL ${check.file}: ${check.reason}`);
  for (const pattern of found) console.error(`  found: ${JSON.stringify(pattern)}`);
}

if (failed) {
  console.error('\nExternal-engine policy is not satisfied.');
  console.error('Clone/inspect the pinned upstream repos and replace synthetic named-engine paths with real execution.');
  process.exit(1);
}

console.log('External-engine policy checks passed: no known synthetic named-engine paths remain.');
