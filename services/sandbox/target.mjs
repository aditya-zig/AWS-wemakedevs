import { spawn } from 'node:child_process';

function secretValues(env = {}) {
  return Object.entries(env)
    .filter(([key, value]) => value && /(secret|token|password|key)/i.test(key))
    .map(([, value]) => String(value));
}

function redact(text, secrets) {
  let output = String(text ?? '');
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

export class TargetRuntime {
  constructor() { this.process = null; }

  async run({ command, cwd = process.cwd(), env = {}, timeoutMs = 30000 }) {
    const secrets = secretValues(env);
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-lc', command], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, signal, stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), command });
      });
    });
  }

  async build(options) { return this.run(options); }

  async start({ command, cwd = process.cwd(), env = {} }) {
    if (this.process) await this.stop();
    this.process = spawn('/bin/sh', ['-lc', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'ignore',
      detached: true
    });
    this.process.unref();
    return { ok: true, pid: this.process.pid, command };
  }

  async healthcheck(url, { timeoutMs = 10000, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'health check timed out';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1000, timeoutMs)) });
        if (response.ok) return { ok: true, status: response.status, url };
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { ok: false, url, error: lastError };
  }

  async stop() {
    if (!this.process) return;
    const pid = this.process.pid;
    this.process = null;
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
