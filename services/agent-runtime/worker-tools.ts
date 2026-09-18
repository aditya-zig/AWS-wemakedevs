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
  const externalEngineUrl = env.VERIFIAI_EXTERNAL_ENGINE_URL;
  const browserUseUrl = env.VERIFIAI_BROWSER_USE_URL;
  const cuaUrl = env.VERIFIAI_CUA_URL;
  const computerUseUrl = env.VERIFIAI_COMPUTER_USE_URL;
  if (targetUrl) allowHosts.add(targetUrl.hostname);
  for (const serviceUrl of [externalEngineUrl, browserUseUrl, cuaUrl, computerUseUrl]) {
    if (serviceUrl) allowHosts.add(new URL(serviceUrl).hostname);
  }
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

  const executeExternalEngine = async (
    engine: 'strix' | 'zap' | 'schemathesis' | 'locust' | 'k6' | 'toxiproxy' | 'mirofish',
    experiment: Record<string, unknown>,
    environment: Record<string, unknown> = {},
  ) => {
    if (!externalEngineUrl) throw new Error('VERIFIAI_EXTERNAL_ENGINE_URL is not configured');
    policy.assertUrl(externalEngineUrl);
    const response = await fetch(new URL('/execute', externalEngineUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.VERIFIAI_EXTERNAL_ENGINE_TOKEN ? { authorization: `Bearer ${env.VERIFIAI_EXTERNAL_ENGINE_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        engine,
        experiment,
        context: {
          target: targetUrl ? { baseUrl: targetUrl.toString(), repository: brief.repository.fullName } : { repository: brief.repository.fullName },
          environment,
        },
      }),
      signal: AbortSignal.timeout(Math.min(brief.constraints.timeoutMs, 175_000)),
    });
    const result: any = await response.json();
    if (!response.ok) throw new Error(`external engine service HTTP ${response.status}: ${safeText(JSON.stringify(result), 2_000)}`);
    for (const item of Array.isArray(result?.evidence) ? result.evidence : []) {
      await record({
        kind: item?.kind ?? 'runtime',
        source: item?.source ?? engine,
        executed: item?.executed === true,
        payload: item?.payload ?? {},
      });
    }
    return result;
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

  if (externalEngineUrl && targetUrl && hasAny(caps, ['mirofish', 'personas', 'customer-simulation'])) {
    tools.push(tool({
      name: 'mirofish_personas',
      description: 'Run the real pinned MiroFish/OASIS pipeline to generate and simulate user personas from actual product context. Use resulting personas/actions to choose subsequent Cua or Browser Use journeys.',
      inputSchema: z.object({
        productContext: z.string().min(20).max(12_000),
        requirement: z.string().min(10).max(2_000).optional(),
        maxRounds: z.number().int().min(1).max(8).default(3),
        platform: z.enum(['parallel', 'twitter', 'reddit']).default('parallel'),
      }),
      callback: async ({ productContext, requirement, maxRounds, platform }) => {
        const result = await executeExternalEngine(
          'mirofish',
          { id: `${brief.workerId}-mirofish`, description: requirement ?? brief.objective },
          {
            mirofish: {
              seedText: productContext,
              requirement: requirement ?? brief.objective,
              projectName: `VERIFIAI ${brief.repository.fullName}`,
              additionalContext: `Target: ${targetUrl.toString()}\nCommit: ${brief.repository.commitSha}`,
              maxRounds,
              platform,
              enableGraphMemoryUpdate: false,
            },
          },
        );
        const evidenceItem = Array.isArray(result?.evidence) ? result.evidence[0] : null;
        const payload = evidenceItem?.payload ?? {};
        return safeText(JSON.stringify({
          status: result.status,
          simulationId: payload.simulationId,
          profileCount: payload.profileCount,
          profiles: Array.isArray(payload.profiles) ? payload.profiles.slice(0, 20) : [],
          actionCount: payload.actionCount,
          actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 50) : [],
        }), 16_000);
      },
    }));
  }

  if (externalEngineUrl && targetUrl && hasAny(caps, ['security', 'strix'])) {
    tools.push(tool({
      name: 'strix_scan',
      description: 'Run the real pinned Strix security scanner against the assigned target. Returns only executed Strix evidence.',
      inputSchema: z.object({
        scanMode: z.enum(['quick', 'standard', 'deep']).default('quick'),
        maxBudgetUsd: z.number().min(0.1).max(2.5).default(0.5),
        instruction: z.string().max(2_000).optional(),
      }),
      callback: async ({ scanMode, maxBudgetUsd, instruction }) => {
        const budget = Math.min(maxBudgetUsd, brief.constraints.maxEstimatedSpendUsd ?? maxBudgetUsd);
        const result = await executeExternalEngine(
          'strix',
          { id: `${brief.workerId}-strix`, description: instruction ?? brief.objective },
          { strix: { target: targetUrl.toString(), scanMode, maxBudgetUsd: budget } },
        );
        return safeText(JSON.stringify({ status: result.status, observations: result.observations, health: result.health }), 8_000);
      },
    }));
  }

  if (externalEngineUrl && targetUrl && hasAny(caps, ['security', 'zap', 'dast'])) {
    tools.push(tool({
      name: 'zap_scan',
      description: 'Run the real pinned OWASP ZAP spider and passive DAST scan against the assigned target.',
      inputSchema: z.object({
        maxChildren: z.number().int().min(1).max(100).default(20),
        maxAlerts: z.number().int().min(1).max(500).default(200),
      }),
      callback: async ({ maxChildren, maxAlerts }) => {
        const result = await executeExternalEngine(
          'zap',
          { id: `${brief.workerId}-zap`, description: brief.objective },
          { zap: { target: targetUrl.toString(), maxChildren, maxAlerts, recurse: true } },
        );
        return safeText(JSON.stringify({ status: result.status, observations: result.observations }), 8_000);
      },
    }));
  }

  if (externalEngineUrl && targetUrl && hasAny(caps, ['schemathesis', 'api-fuzz', 'api'])) {
    tools.push(tool({
      name: 'schemathesis_fuzz',
      description: 'Run real pinned Schemathesis property/fuzz testing against the target OpenAPI or GraphQL schema.',
      inputSchema: z.object({
        schemaPath: z.string().min(1).max(500).default('/openapi.json'),
        maxExamples: z.number().int().min(1).max(100).default(25),
      }),
      callback: async ({ schemaPath, maxExamples }) => {
        const schemaUrl = new URL(schemaPath, targetUrl);
        if (schemaUrl.origin !== targetUrl.origin) throw new Error('schemaPath cannot leave the assigned target origin');
        const result = await executeExternalEngine(
          'schemathesis',
          { id: `${brief.workerId}-schemathesis`, description: brief.objective },
          { schemathesis: { schemaUrl: schemaUrl.toString(), maxExamples } },
        );
        return safeText(JSON.stringify({ status: result.status, observations: result.observations }), 8_000);
      },
    }));
  }

  if (externalEngineUrl && targetUrl && hasAny(caps, ['performance', 'latency', 'load', 'locust', 'k6'])) {
    tools.push(tool({
      name: 'load_test',
      description: 'Run a bounded real Locust or k6 load test against the assigned target. This is the real upstream engine, not the lightweight HTTP probe.',
      inputSchema: z.object({
        engine: z.enum(['locust', 'k6']).default('locust'),
        path: z.string().min(1).max(500).default('/'),
        concurrency: z.number().int().min(1).max(25).default(2),
        durationSec: z.number().int().min(1).max(60).default(10),
        maxP95Ms: z.number().min(1).max(60_000).default(1_000),
        maxErrorRate: z.number().min(0).max(1).default(0.01),
      }),
      callback: async ({ engine, path, concurrency, durationSec, maxP95Ms, maxErrorRate }) => {
        const probeUrl = new URL(path, targetUrl);
        if (probeUrl.origin !== targetUrl.origin) throw new Error('load-test path cannot leave the assigned target origin');
        const result = await executeExternalEngine(
          engine,
          { id: `${brief.workerId}-${engine}`, description: brief.objective },
          { performance: { path: probeUrl.pathname + probeUrl.search, concurrency, durationSec, maxP95Ms, maxErrorRate } },
        );
        return safeText(JSON.stringify({ status: result.status, observations: result.observations }), 8_000);
      },
    }));
  }

  if (externalEngineUrl && hasAny(caps, ['chaos', 'toxiproxy', 'fault'])) {
    tools.push(tool({
      name: 'toxiproxy_fault',
      description: 'Create a real Toxiproxy proxy/toxic for an authorized sandbox dependency and optionally probe the observed failure.',
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        listen: z.string().min(3).max(200),
        upstream: z.string().min(3).max(200),
        toxicType: z.enum(['latency', 'timeout', 'reset_peer', 'bandwidth']).default('latency'),
        latencyMs: z.number().int().min(1).max(30_000).default(1_000),
        probeUrl: z.string().url().optional(),
        probeTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
      }),
      callback: async ({ name, listen, upstream, toxicType, latencyMs, probeUrl, probeTimeoutMs }) => {
        const attributes = toxicType === 'latency' ? { latency: latencyMs, jitter: 0 } : toxicType === 'timeout' ? { timeout: latencyMs } : {};
        const result = await executeExternalEngine(
          'toxiproxy',
          { id: `${brief.workerId}-toxiproxy`, description: brief.objective },
          { toxiproxy: { name, listen, upstream, toxic: { name: toxicType, type: toxicType, stream: 'downstream', toxicity: 1, attributes }, probeUrl, probeTimeoutMs } },
        );
        return safeText(JSON.stringify({ status: result.status, observations: result.observations }), 8_000);
      },
    }));
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

  if (targetUrl && hasAny(caps, ['browser', 'desktop', 'computer-use', 'computer', 'browser-use', 'cua'])) {
    const availableEngines = [
      browserUseUrl ? 'browser-use' : null,
      cuaUrl ? 'cua' : null,
      computerUseUrl ? 'generic' : null,
    ].filter(Boolean) as string[];

    if (availableEngines.length) {
      tools.push(tool({
        name: 'computer_use',
        description: 'Execute a real user journey with Browser Use or Cua. The selected upstream service must return real actions/screenshots; no synthetic fallback is accepted.',
        inputSchema: z.object({
          engine: z.enum(['browser-use', 'cua', 'generic']).default(browserUseUrl ? 'browser-use' : cuaUrl ? 'cua' : 'generic'),
          objective: z.string().min(1).max(2_000),
          persona: z.string().min(1).max(1_000).optional(),
        }),
        callback: async ({ engine, objective, persona }) => {
          const serviceUrl = engine === 'browser-use' ? browserUseUrl : engine === 'cua' ? cuaUrl : computerUseUrl;
          if (!serviceUrl) throw new Error(`${engine} computer-use service is not configured`);
          policy.assertUrl(serviceUrl);
          const endpoint = engine === 'generic' ? serviceUrl : new URL('/run', serviceUrl).toString();
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(env.VERIFIAI_COMPUTER_USE_TOKEN ? { authorization: `Bearer ${env.VERIFIAI_COMPUTER_USE_TOKEN}` } : {}),
            },
            body: JSON.stringify({
              auditId: brief.auditId,
              workerId: brief.workerId,
              runId: `${brief.auditId}-${brief.workerId}`,
              targetUrl: targetUrl.toString(),
              objective,
              persona,
            }),
            signal: AbortSignal.timeout(Math.min(brief.constraints.timeoutMs, 120_000)),
          });
          const result: any = await response.json().catch(() => ({}));
          const expectedCommit = engine === 'browser-use'
            ? 'd8110c5ff87ccba887aaa726cdb780f2f84bef8d'
            : engine === 'cua'
              ? '05f29785b508a4441ec3aa06c556a8e8b26c1d71'
              : undefined;
          const expectedEngine = engine === 'browser-use' ? 'Browser Use' : engine === 'cua' ? 'Cua' : undefined;
          const identityOk = engine === 'generic' || (result?.engine === expectedEngine && result?.upstreamCommit === expectedCommit);
          const executed = response.ok && result?.ok !== false && identityOk;
          const item: EvidenceInput = {
            kind: 'screenshot',
            source: engine,
            executed,
            payload: {
              engine: result?.engine ?? engine,
              upstreamRepo: result?.upstreamRepo,
              upstreamCommit: result?.upstreamCommit,
              outcome: executed ? (result?.successful === false ? 'fail' : 'pass') : 'unknown',
              status: response.status,
              objective,
              persona,
              targetUrl: targetUrl.toString(),
              screenshotRefs: Array.isArray(result?.screenshotRefs) ? result.screenshotRefs.slice(0, 20) : [],
              actions: Array.isArray(result?.actions) ? result.actions.slice(0, 100) : [],
              urls: Array.isArray(result?.urls) ? result.urls.slice(0, 100) : [],
              finalResult: typeof result?.finalResult === 'string' ? safeText(result.finalResult, 5_000) : undefined,
              summary: typeof result?.summary === 'string' ? safeText(result.summary, 5_000) : undefined,
              identityVerified: identityOk,
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
