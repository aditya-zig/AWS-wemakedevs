import { spawn } from 'node:child_process';

export function runExternalCommand(command, args = [], options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 120000));
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - startedAt, stdout, stderr: String(error) });
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Date.now() - startedAt, stdout, stderr });
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, exitCode: null, signal: null, timedOut: false, stderr: `${stderr}${error.message}` }));
    child.on('close', (exitCode, signal) => finish({ ok: exitCode === 0, exitCode, signal, timedOut: false }));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      finish({ ok: false, exitCode: null, signal: 'SIGTERM', timedOut: true });
    }, timeoutMs);
  });
}

export async function commandHealth(command, args = ['--version'], options = {}) {
  const result = await runExternalCommand(command, args, { ...options, timeoutMs: options.timeoutMs ?? 10000 });
  return {
    ok: result.exitCode === 0,
    detail: result.exitCode === 0
      ? (result.stdout || result.stderr || `${command} available`).trim().slice(0, 500)
      : `${command} unavailable: ${(result.stderr || result.stdout || 'not found').trim().slice(0, 500)}`,
    result,
  };
}

export function boundedText(value, max = 12000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated]`;
}
