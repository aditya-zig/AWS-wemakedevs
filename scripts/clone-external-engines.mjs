#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifest = JSON.parse(readFileSync(join(root, 'config/external-engines.json'), 'utf8'));
const sourceRoot = join(root, manifest.sourceRoot || '.external');
const requested = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith('--')));
const engines = requested.size
  ? manifest.engines.filter((engine) => requested.has(engine.id))
  : manifest.engines;

if (requested.size && engines.length !== requested.size) {
  const known = new Set(manifest.engines.map((engine) => engine.id));
  const missing = [...requested].filter((id) => !known.has(id));
  throw new Error(`unknown external engine(s): ${missing.join(', ')}`);
}

mkdirSync(sourceRoot, { recursive: true });

function run(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: options.cwd ?? root,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? (result.stdout || '').trim() : '';
}

run(['--version']);

for (const engine of engines) {
  const dest = join(sourceRoot, engine.id);
  const expectedRemote = `https://github.com/${engine.repo}.git`;

  if (!existsSync(join(dest, '.git'))) {
    run(['clone', '--filter=blob:none', '--no-checkout', expectedRemote, dest]);
  } else {
    const origin = run(['-C', dest, 'remote', 'get-url', 'origin'], { capture: true });
    const normalized = origin.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
    const expected = expectedRemote.replace(/\.git$/, '');
    if (normalized !== expected) {
      throw new Error(`${engine.id}: existing checkout points at ${origin}, expected ${expectedRemote}`);
    }
  }

  run(['-C', dest, 'fetch', '--depth=1', 'origin', engine.commit]);
  run(['-C', dest, 'checkout', '--detach', '--force', engine.commit]);

  const actual = run(['-C', dest, 'rev-parse', 'HEAD'], { capture: true });
  if (actual !== engine.commit) {
    throw new Error(`${engine.id}: expected ${engine.commit}, got ${actual}`);
  }

  const dirty = run(['-C', dest, 'status', '--porcelain'], { capture: true });
  if (dirty) throw new Error(`${engine.id}: upstream checkout is dirty; do not edit vendored source in place`);

  process.stdout.write(`OK ${engine.id} ${engine.repo}@${actual} ${engine.license}\n`);
}

process.stdout.write(
  `Cloned ${engines.length} pinned upstream engine(s) into ${manifest.sourceRoot || '.external'}.\n` +
  'Implement thin adapters against these real sources/runtimes. Do not replace them with compatibility shims.\n',
);
