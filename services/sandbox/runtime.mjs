import { mkdir, rm, readdir, writeFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';

function safeId(value) {
  const id = String(value ?? '').replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!id) throw new Error('run id is required');
  return id;
}

export class SandboxManager {
  constructor({ root = '/tmp/verifiai-runs' } = {}) {
    this.root = root;
    this.runs = new Map();
  }

  async reset() {
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    this.runs.clear();
  }

  async create(runId, options = {}) {
    const id = safeId(runId);
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, id);
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
    const state = {
      id,
      path,
      mode: options.mode ?? 'local-fallback',
      createdAt: new Date().toISOString(),
      resourceLimits: options.resourceLimits ?? { cpus: 1, memoryMb: 512 },
      faults: []
    };
    this.runs.set(id, state);
    return { ...state };
  }

  async exists(runId) {
    try {
      await access(join(this.root, safeId(runId)));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(runId) {
    const path = join(this.root, safeId(runId));
    try { return (await readdir(path)).sort(); } catch { return []; }
  }

  async writeArtifact(runId, filename, content) {
    const id = safeId(runId);
    if (!this.runs.has(id)) throw new Error(`sandbox ${id} not found`);
    const file = basename(filename);
    const path = join(this.root, id, file);
    await writeFile(path, content, 'utf8');
    return path;
  }

  injectFault(runId, fault) {
    const id = safeId(runId);
    const state = this.runs.get(id);
    if (!state) throw new Error(`sandbox ${id} not found`);
    const record = { ...fault, active: true, injectedAt: new Date().toISOString() };
    state.faults.push(record);
    return record;
  }

  clearFaults(runId) {
    const state = this.runs.get(safeId(runId));
    if (!state) return [];
    for (const fault of state.faults) fault.active = false;
    return state.faults.map((fault) => ({ ...fault }));
  }

  getState(runId) {
    const state = this.runs.get(safeId(runId));
    return state ? structuredClone(state) : null;
  }

  async destroy(runId) {
    const id = safeId(runId);
    await rm(join(this.root, id), { recursive: true, force: true });
    this.runs.delete(id);
  }
}
