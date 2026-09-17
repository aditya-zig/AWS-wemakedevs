import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const safe = (value) => {
  const result = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!result) throw new Error('identifier required');
  return result;
};

export class EvidenceSink {
  constructor({ root = '/tmp/verifiai-evidence' } = {}) { this.root = root; }

  async reset() { await rm(this.root, { recursive: true, force: true }); }

  async record(runId, experimentId, evidence) {
    const run = safe(runId);
    const dir = join(this.root, run);
    await mkdir(dir, { recursive: true });
    const entry = {
      id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      runId: run,
      experimentId: safe(experimentId),
      capturedAt: new Date().toISOString(),
      ...evidence
    };
    await appendFile(join(dir, 'evidence.ndjson'), `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  async writeArtifact(runId, filename, content) {
    const dir = join(this.root, safe(runId), 'artifacts');
    await mkdir(dir, { recursive: true });
    const path = join(dir, basename(filename));
    await writeFile(path, content, 'utf8');
    return path;
  }

  async list(runId) {
    try {
      const text = await readFile(join(this.root, safe(runId), 'evidence.ndjson'), 'utf8');
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch { return []; }
  }
}
