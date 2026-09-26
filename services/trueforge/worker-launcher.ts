import {
  AGENT_WORKER_CONTRACT_VERSION,
  assertAgentWorkerLaunchBrief,
  type AgentWorkerEventSink,
  type AgentWorkerLaunchBrief,
  type AgentWorkerLauncher,
  type AgentWorkerReport,
  type AgentWorkerSession,
  type EvidenceFindingState,
  type EvidenceInput,
} from '../../packages/contracts/src/index.js';
import { TrueForgeHarnessClient, type TrueForgeInlineAgentSpec } from './client.js';

export interface TrueForgeWorkerLauncherOptions {
  baseUrl?: string;
  token?: string;
  mcpServers?: string[];
  requireApprovalForTools?: string[];
  sandboxEnabled?: boolean;
  timeoutMs?: number;
}

function parseJsonObject(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('TrueForge worker did not return JSON');
}

function modelFromProfile(profileId: string): string {
  const prefix = 'trueforge:';
  if (!profileId.startsWith(prefix) || profileId.length <= prefix.length) {
    throw new Error('TrueForge worker requires modelProfileId=trueforge:<configured-model-name>');
  }
  return profileId.slice(prefix.length);
}

function findingState(value: unknown): EvidenceFindingState {
  return value === 'Confirmed' || value === 'Unconfirmed' || value === 'Unknown' || value === 'Incomplete'
    ? value
    : 'Unknown';
}

function safeJson(value: unknown, limit = 12_000): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function evidenceFromToolResponse(event: any): EvidenceInput | undefined {
  if (event?.type !== 'tool.response') return undefined;
  const candidates = [
    event?.content,
    event?.output,
    event?.response,
    event?.result,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.kind === 'string' &&
        typeof parsed.source === 'string' &&
        parsed.executed === true &&
        parsed.payload &&
        typeof parsed.payload === 'object'
      ) {
        return parsed as EvidenceInput;
      }
    } catch {}
  }

  const toolName = event?.tool_name ?? event?.toolName ?? event?.name ?? event?.tool?.name ?? 'unknown';
  return {
    kind: 'runtime',
    source: 'trueforge-tool',
    executed: true,
    payload: {
      outcome: 'unknown',
      toolName,
      response: safeJson(event?.content ?? event?.output ?? event?.response ?? event?.result ?? null),
      harnessEventType: 'tool.response',
    },
  };
}

function normalizeReport(
  brief: AgentWorkerLaunchBrief,
  raw: any,
  evidence: EvidenceInput[],
  evidenceRefs: string[],
): AgentWorkerReport {
  const findings = Array.isArray(raw?.findings)
    ? raw.findings.filter((item: unknown) => typeof item === 'string').slice(0, 25)
    : [];
  const summary = typeof raw?.summary === 'string' && raw.summary.trim()
    ? raw.summary.trim()
    : 'TrueForge worker completed without a summary.';
  const requestedState = findingState(raw?.findingState);
  const hasExecutedFail = evidence.some((item) =>
    item.executed === true &&
    item.source !== 'llm' &&
    item.payload?.outcome === 'fail',
  );
  const normalizedState: EvidenceFindingState =
    requestedState === 'Confirmed' && !hasExecutedFail ? 'Unconfirmed' : requestedState;

  const allowedFollowUps = new Set(['hypothesis', 'investigator', 'judge', 'reverification']);
  const followUps = (Array.isArray(raw?.followUps) ? raw.followUps : []).flatMap((item: any) => {
    if (!allowedFollowUps.has(item?.role)) return [];
    if (typeof item?.objective !== 'string' || !item.objective.trim()) return [];
    if (typeof item?.reason !== 'string' || !item.reason.trim()) return [];
    return [{
      role: item.role,
      objective: item.objective.trim(),
      reason: item.reason.trim(),
      evidenceRefs: Array.isArray(item?.evidenceRefs)
        ? item.evidenceRefs.filter((ref: unknown) => typeof ref === 'string')
        : [],
    }];
  });

  const verificationDecision =
    raw?.verificationDecision === 'pass' || raw?.verificationDecision === 'fail' || raw?.verificationDecision === 'unknown'
      ? raw.verificationDecision
      : undefined;

  return {
    contractVersion: AGENT_WORKER_CONTRACT_VERSION,
    auditId: brief.auditId,
    workerId: brief.workerId,
    role: brief.role,
    outcome: normalizedState === 'Incomplete' ? 'incomplete' : 'completed',
    findingState: normalizedState,
    summary,
    findings,
    evidence,
    evidenceRefs,
    followUps,
    verificationDecision,
  };
}

export class TrueForgeWorkerLauncher implements AgentWorkerLauncher {
  private readonly client: TrueForgeHarnessClient;
  private readonly mcpServers: string[];
  private readonly requireApprovalForTools: string[];
  private readonly sandboxEnabled: boolean;
  private readonly timeoutMs: number;

  constructor(options: TrueForgeWorkerLauncherOptions = {}) {
    this.client = new TrueForgeHarnessClient({
      baseUrl: options.baseUrl,
      token: options.token,
      timeoutMs: options.timeoutMs,
    });
    this.mcpServers = (options.mcpServers ?? []).map((value) => value.trim()).filter(Boolean);
    this.requireApprovalForTools = options.requireApprovalForTools ?? ['@destructive'];
    this.sandboxEnabled = options.sandboxEnabled === true;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async launch(brief: AgentWorkerLaunchBrief, onEvent: AgentWorkerEventSink): Promise<AgentWorkerSession> {
    assertAgentWorkerLaunchBrief(brief);
    const model = modelFromProfile(brief.modelProfileId);
    const controller = new AbortController();

    await onEvent({
      type: 'worker.status',
      auditId: brief.auditId,
      workerId: brief.workerId,
      at: new Date().toISOString(),
      phase: 'launching',
      message: 'Creating TrueForge harness session',
      progress: 5,
    });

    const spec: TrueForgeInlineAgentSpec = {
      model: { name: model },
      instructions: [
        `You are the VERIFAI ${brief.role} specialist running inside TrueForge.`,
        'Use only real tools available through the configured TrueForge MCP connectors or sandbox.',
        'Do not invent executed evidence, screenshots, findings, target state, or tool results.',
        'Treat the supplied repository commit and target as immutable facts.',
        'Respect the approved capability list and network/destructive constraints.',
        'Return JSON only with keys: summary, findingState, findings, followUps, verificationDecision.',
        'findingState must be Confirmed, Unconfirmed, Unknown, or Incomplete.',
        'A finding may be Confirmed only when a real executed tool result demonstrates the failure.',
        'If required tooling is unavailable, return findingState=Incomplete and explain exactly what is missing.',
        'Do not include an evidence array in the final answer; VERIFAI records evidence from actual harness tool events.',
      ].join(' '),
      ...(this.mcpServers.length ? {
        mcp_servers: this.mcpServers.map((name) => ({
          name,
          enable_tools: ['@all'],
          require_approval_for_tools: [...this.requireApprovalForTools],
        })),
      } : {}),
      config: {
        iteration_limit: Math.max(4, Math.min(brief.constraints.maxToolCalls + 8, 128)),
        ask_user_questions: { enabled: false },
        dynamic_sub_agents: { enabled: false },
        generative_ui: { enabled: false },
        sandbox: { enabled: this.sandboxEnabled },
      },
    };

    const sessionId = await this.client.createSession(spec, controller.signal);

    const result = (async (): Promise<AgentWorkerReport> => {
      const evidence: EvidenceInput[] = [];
      const evidenceRefs: string[] = [];
      await onEvent({
        type: 'worker.status',
        auditId: brief.auditId,
        workerId: brief.workerId,
        at: new Date().toISOString(),
        phase: 'running',
        message: 'TrueForge agent turn started',
        progress: 15,
      });

      try {
        const run = await this.client.runTurn(
          sessionId,
          [
            'Execute this VERIFAI worker brief.',
            JSON.stringify({
              auditId: brief.auditId,
              workerId: brief.workerId,
              role: brief.role,
              objective: brief.objective,
              repository: brief.repository,
              target: brief.target,
              approvedTools: brief.tools,
              evidenceRefs: brief.evidenceRefs,
              constraints: brief.constraints,
            }),
          ].join('\n'),
          {
            timeoutMs: Math.min(this.timeoutMs, brief.constraints.timeoutMs),
            signal: controller.signal,
            onEvent: async (event) => {
              const item = evidenceFromToolResponse(event);
              if (!item) return;
              if (evidence.length >= brief.constraints.maxEvidenceItems) return;
              const ref = `trueforge:${sessionId}:tool:${evidence.length + 1}`;
              evidence.push(item);
              evidenceRefs.push(ref);
              await onEvent({
                type: 'worker.evidence',
                auditId: brief.auditId,
                workerId: brief.workerId,
                at: new Date().toISOString(),
                evidence: item,
              });
            },
          },
        );

        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: new Date().toISOString(),
          phase: 'reporting',
          message: `TrueForge turn finished with status ${run.status}`,
          progress: 90,
        });

        if (run.status !== 'done') {
          return {
            contractVersion: AGENT_WORKER_CONTRACT_VERSION,
            auditId: brief.auditId,
            workerId: brief.workerId,
            role: brief.role,
            outcome: 'incomplete',
            findingState: 'Incomplete',
            summary: `TrueForge turn ended with status ${run.status}.`,
            findings: [],
            evidence,
            evidenceRefs,
            followUps: [],
            error: `TrueForge turn status: ${run.status}`,
          };
        }

        const parsed = parseJsonObject(run.answer);
        const report = normalizeReport(brief, parsed, evidence, evidenceRefs);
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: new Date().toISOString(),
          phase: 'completed',
          message: 'TrueForge worker report normalized',
          progress: 100,
        });
        return report;
      } catch (error: any) {
        const aborted = controller.signal.aborted;
        const message = String(error?.message ?? error);
        await onEvent({
          type: 'worker.status',
          auditId: brief.auditId,
          workerId: brief.workerId,
          at: new Date().toISOString(),
          phase: aborted ? 'incomplete' : 'failed',
          message,
          progress: 100,
        });
        return {
          contractVersion: AGENT_WORKER_CONTRACT_VERSION,
          auditId: brief.auditId,
          workerId: brief.workerId,
          role: brief.role,
          outcome: aborted ? 'incomplete' : 'failed',
          findingState: aborted ? 'Incomplete' : 'Unknown',
          summary: aborted ? 'TrueForge worker was stopped.' : 'TrueForge worker failed before producing a valid report.',
          findings: [],
          evidence,
          evidenceRefs,
          followUps: [],
          error: message,
        };
      }
    })();

    return {
      workerId: brief.workerId,
      sessionId,
      result,
      stop: async (reason = 'VERIFAI worker stopped') => {
        if (!controller.signal.aborted) controller.abort(new Error(reason));
        await this.client.cancelSession(sessionId).catch(() => undefined);
      },
    };
  }

  async teardown(session: AgentWorkerSession): Promise<void> {
    await session.stop('VERIFAI worker teardown');
  }
}
