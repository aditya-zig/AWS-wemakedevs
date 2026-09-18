import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import type {
  AgentWorkerEvidenceEvent,
  AgentWorkerLaunchBrief,
  EvidenceInput,
} from '../../packages/contracts/src/index.js';
import { WorkerNetworkPolicy } from '../orchestrator/guardrails.js';

export interface WorkerToolBundle {
  tools: any[];
  evidence: EvidenceInput[];
}

function capabilitySet(brief: AgentWorkerLaunchBrief): Set<string> {
  return new Set(brief.tools.flatMap((grant) => [grant.name, ...grant.capabilities]).map((value) => value.toLowerCase()));
}

function hasAny(caps: Set<string>, values: string[]): boolean {
  return values.some((value) => caps.has(value) || [...caps].some((cap) => cap.includes(value)));
}

function safeRepoPath(path: string): string {
  const clean = path.trim().replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..')) throw new Error('repository path escapes the repository root');
  if (clean.length > 400) throw new Error('repository path is too long');
  return clean;
}

function safeText(text: string, limit = 20_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`;
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const keep = ['content-type', 'content-length', 'cache-control', 'location', 'server'];
  return Object.fromEntries(keep.map((name) => [name, headers.get(name)]).filter(([, value]) => value));
}

export function createWorkerTools(
  brief: AgentWorkerLaunchBrief,
  emit: (event: AgentWorkerEvidenceEvent) => void | Promise<void>,
  env: Record<string, string | undefined> = process.env,
): WorkerToolBundle {
  const evidence: EvidenceInput[] = [];
  const tools: any[] = [];
  const caps = capabilitySet(brief);
  const allowHosts = new Set(brief.constraints.networkAllowlist.map((value) => value.trim()).filter(Boolean));
  const targetUrl = brief.target?.url ? new URL(brief.target.url) : null;
  if (targetUrl) allowHosts.add(targetUrl.hostname);
  const policy = new WorkerNetworkPolicy([...allowHosts]);
  let toolCalls = 0;

  const record = async (item: EvidenceInput) => {
    if (++toolCalls > brief.constraints.maxToolCalls) throw new Error('Worker tool-call limit reached');
    if (evidence.length >= brief.constraints.maxEvidenceItems) throw new Error('Worker evidence-item limit reached');
    evidence.push(item);
    await emit({
      type: 'worker.evidence',
      auditId: brief.auditId,
      workerId: brief.workerId,
      at: new Date().toISOString(),
      evidence: item,
    });
  };

  if (hasAny(caps, ['repository', 'repo', 'source', 'security'])) {
    tools.push(tool({
      name: 'repo_tree',
      description: 'List files from the exact audited GitHub commit. Use this before reading unfamiliar paths.',
      inputSchema: z.object({
        prefix: z.string().max(200).optional().describe('Optional path prefix to filter the tree.'),
      }),
      callback: async ({ prefix }) => {
        const url = `https://api.github.com/repos/${brief.repository.fullName}/git/trees/${encodeURIComponent(brief.repository.commitSha)}?recursive=1`;
        policy.assertUrl(url);
        const response = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'verifiai-worker' } });
        const body: any = await response.json();
        const paths = (Array.isArray(body?.tree) ? body.tree : [])
          .filter((entry: any) => entry?.type === 'blob' && typeof entry?.path === 'string')
          .map((entry: any) => entry.path as string)
          .filter((path: string) => !prefix || path.startsWith(prefix))
          .slice(0, 2_000);
        const item: EvidenceInput = {
          kind: 'code',
          source: 'github-tree',
          executed: true,
          payload: { outcome: response.ok ? 'pass' : 'unknown', status: response.status, commitSha: brief.repository.commitSha, paths },
        };
        await record(item);
        return JSON.stringify(item.payload);
      },
    }));

    tools.push(tool({
      name: 'repo_read',
      description: 'Read a UTF-8 text file from the exact audited GitHub commit. Never use it for secrets outside the repository.',
      inputSchema: z.object({
        path: z.string().min(1).max(400),
      }),
      callback: async ({ path }) => {
        const clean = safeRepoPath(path);
        const url = `https://raw.githubusercontent.com/${brief.repository.fullName}/${encodeURIComponent(brief.repository.commitSha)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
        policy.assertUrl(url);
        const response = await fetch(url, { headers: { 'user-agent': 'verifiai-worker' } });
        const text = safeText(await response.text(), 30_000);
        const item: EvidenceInput = {
          kind: 'code',
          source: 'github-raw',
          executed: true,
          payload: { outcome: response.ok ? 'pass' : 'unknown', status: response.status, path: clean, content: text },
        };
        await record(item);
        return JSON.stringify(item.payload);
      },
    }));
  }

  if (targetUrl && hasAny(caps, ['http', 'api', 'chaos', 'performance', 'browser'])) {
    tools.push(tool({
      name: 'target_http',
      description: 'Send a scoped HTTP request to the audited target only. Mutation methods require an isolated mutation target and destructive permission.',
      inputSchema: z.object({
        method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().min(1).max(500).default('/'),
        body: z.string().max(20_000).optional(),
      }),
      callback: async ({ method, path, body }) => {
        if (!['GET', 'HEAD'].includes(method) && !brief.constraints.destructiveAllowed) {
          throw new Error('mutation HTTP methods are forbidden for this worker');
        }
        const url = new URL(path, targetUrl);
        if (url.origin !== targetUrl.origin) throw new Error('target_http cannot leave the assigned target origin');
        policy.assertUrl(url.toString());
        const started = Date.now();
        const response = await fetch(url, {
          method,
          body: ['GET', 'HEAD'].includes(method) ? undefined : body,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)),
          redirect: 'manual',
        });
        const text = method === 'HEAD' ? '' : safeText(await response.text());
        const item: EvidenceInput = {
          kind: 'network',
          source: 'target-http',
          executed: true,
          payload: {
            outcome: response.ok ? 'pass' : 'fail',
            method,
            url: url.toString(),
            status: response.status,
            durationMs: Date.now() - started,
            headers: selectedHeaders(response.headers),
            body: text,
          },
        };
        await record(item);
        return JSON.stringify(item.payload);
      },
    }));

    if (hasAny(caps, ['performance', 'latency', 'load'])) {
      tools.push(tool({
        name: 'performance_probe',
        description: 'Run a small bounded latency sample against a target path. This is not an unbounded load test.',
        inputSchema: z.object({
          path: z.string().min(1).max(500).default('/'),
          requests: z.number().int().min(1).max(10).default(3),
        }),
        callback: async ({ path, requests }) => {
          const url = new URL(path, targetUrl);
          if (url.origin !== targetUrl.origin) throw new Error('performance_probe cannot leave the assigned target origin');
          policy.assertUrl(url.toString());
          const samples: number[] = [];
          const statuses: number[] = [];
          for (let index = 0; index < requests; index += 1) {
            const started = Date.now();
            const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(15_000, brief.constraints.timeoutMs)) });
            samples.push(Date.now() - started);
            statuses.push(response.status);
            await response.arrayBuffer();
          }
          const sorted = [...samples].sort((a, b) => a - b);
          const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
          const item: EvidenceInput = {
            kind: 'metric',
            source: 'performance-probe',
            executed: true,
            payload: { outcome: statuses.every((status) => status < 500) ? 'pass' : 'fail', url: url.toString(), samplesMs: samples, p95Ms: p95, statuses },
          };
          await record(item);
          return JSON.stringify(item.payload);
        },
      }));
    }
  }

  if (brief.target?.environment === 'isolated-mutation' && brief.constraints.destructiveAllowed && hasAny(caps, ['mutation', 'repair', 'edit', 'patch'])) {
    const mutationServiceUrl = env.VERIFIAI_MUTATION_SERVICE_URL;
    if (mutationServiceUrl) {
      tools.push(tool({
        name: 'apply_candidate_patch',
        description: 'Apply a candidate code patch only inside the assigned isolated mutation workspace. Returns the real diff and changed files from the mutation service.',
        inputSchema: z.object({
          diagnosis: z.string().min(1).max(5_000),
          desiredBehavior: z.string().min(1).max(5_000),
        }),
        callback: async ({ diagnosis, desiredBehavior }) => {
          policy.assertUrl(mutationServiceUrl);
          const response = await fetch(mutationServiceUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(env.VERIFIAI_MUTATION_SERVICE_TOKEN ? { authorization: `Bearer ${env.VERIFIAI_MUTATION_SERVICE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              auditId: brief.auditId,
              workerId: brief.workerId,
              repository: brief.repository,
              target: brief.target,
              diagnosis,
              desiredBehavior,
            }),
            signal: AbortSignal.timeout(Math.min(120_000, brief.constraints.timeoutMs)),
          });
          const result: any = await response.json();
          const diff = typeof result?.diff === 'string' ? safeText(result.diff, 50_000) : '';
          const branch = typeof result?.branch === 'string' ? result.branch : '';
          const changedFiles = Array.isArray(result?.changedFiles) ? result.changedFiles.filter((item: unknown) => typeof item === 'string').slice(0, 100) : [];
          const item: EvidenceInput = {
            kind: 'code',
            source: 'mutation-service',
            executed: true,
            payload: {
              outcome: response.ok && result?.ok !== false && Boolean(diff) ? 'pass' : 'fail',
              status: response.status,
              branch,
              diff,
              changedFiles,
              appUrl: typeof result?.appUrl === 'string' ? result.appUrl : undefined,
              diagnosis,
              desiredBehavior,
            },
          };
          await record(item);
          return JSON.stringify(item.payload);
        },
      }));
    }
  }

  if (targetUrl && hasAny(caps, ['browser', 'desktop', 'computer-use', 'computer'])) {
    const computerUseUrl = env.VERIFIAI_COMPUTER_USE_URL;
    if (computerUseUrl) {
      tools.push(tool({
        name: 'computer_use',
        description: 'Ask the run-scoped browser/computer-use service to execute a real user journey against the assigned target and return screenshots/action evidence.',
        inputSchema: z.object({
          objective: z.string().min(1).max(2_000),
          persona: z.string().min(1).max(1_000).optional(),
        }),
        callback: async ({ objective, persona }) => {
          policy.assertUrl(computerUseUrl);
          const response = await fetch(computerUseUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(env.VERIFIAI_COMPUTER_USE_TOKEN ? { authorization: `Bearer ${env.VERIFIAI_COMPUTER_USE_TOKEN}` } : {}),
            },
            body: JSON.stringify({ auditId: brief.auditId, workerId: brief.workerId, targetUrl: targetUrl.toString(), objective, persona }),
            signal: AbortSignal.timeout(Math.min(60_000, brief.constraints.timeoutMs)),
          });
          const result: any = await response.json();
          const item: EvidenceInput = {
            kind: 'screenshot',
            source: 'computer-use',
            executed: true,
            payload: {
              outcome: response.ok && result?.ok !== false ? 'pass' : 'fail',
              status: response.status,
              objective,
              persona,
              screenshotRefs: Array.isArray(result?.screenshotRefs) ? result.screenshotRefs.slice(0, 20) : [],
              actions: Array.isArray(result?.actions) ? result.actions.slice(0, 100) : [],
              summary: typeof result?.summary === 'string' ? safeText(result.summary, 5_000) : undefined,
            },
          };
          await record(item);
          return JSON.stringify(item.payload);
        },
      }));
    }
  }

  return { tools, evidence };
}
