import type {
  AuditPlannerContext,
  AuditPlanningAgent,
  PlannedWorker,
} from './strands-orchestrator.js';
import { TrueForgeHarnessClient } from '../trueforge/client.js';

const ALLOWED_ROLES = new Set([
  'security-secrets',
  'browser-app-user',
  'api-chaos',
  'performance-discovery',
  'hypothesis',
  'investigator',
  'judge',
  'repair',
  'reverification',
]);

function parseJsonObject(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('TrueForge planner did not return JSON');
}

export interface CreateTrueForgePlanningAgentOptions {
  baseUrl?: string;
  token?: string;
  model: string;
  timeoutMs?: number;
}

export class TrueForgeAuditPlanningAgent implements AuditPlanningAgent {
  constructor(
    private readonly client: TrueForgeHarnessClient,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async propose(context: AuditPlannerContext): Promise<PlannedWorker[]> {
    const sessionId = await this.client.createSession({
      model: { name: this.model },
      instructions: [
        'You are the VERIFAI Deep Audit planner running inside the TrueForge harness.',
        'Plan isolated specialist work only. Do not perform verification yourself.',
        'Never invent targets, tools, credentials, findings, or evidence.',
        'Return JSON only: {"workers":[{"role":"...","objective":"...","mandatory":true}]}.',
        'Use only roles supplied in availableRoles. Prefer the smallest useful worker set.',
        'Workers do not communicate peer-to-peer. Respect the repository and target facts exactly.',
      ].join(' '),
      config: {
        iteration_limit: 8,
        ask_user_questions: { enabled: false },
        dynamic_sub_agents: { enabled: false },
        generative_ui: { enabled: false },
        sandbox: { enabled: false },
      },
    });

    const result = await this.client.runTurn(
      sessionId,
      [
        'Create the initial VERIFAI Deep Audit worker plan.',
        'Repository facts, target facts, requested objective, and availableRoles follow.',
        JSON.stringify(context),
      ].join('\n'),
      { timeoutMs: this.timeoutMs },
    );

    if (result.status !== 'done') throw new Error(`TrueForge planner ended with status ${result.status}`);
    const parsed = parseJsonObject(result.answer);
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [];
    if (workers.length === 0) throw new Error('TrueForge planner returned no workers');

    return workers.map((worker: any, index: number) => {
      if (!ALLOWED_ROLES.has(worker?.role) || !context.availableRoles.includes(worker.role)) {
        throw new Error(`TrueForge planner returned invalid role at workers[${index}]`);
      }
      if (typeof worker?.objective !== 'string' || !worker.objective.trim()) {
        throw new Error(`TrueForge planner returned empty objective at workers[${index}]`);
      }
      return {
        role: worker.role,
        objective: worker.objective.trim(),
        mandatory: worker.mandatory !== false,
      } as PlannedWorker;
    });
  }
}

export async function createTrueForgePlanningAgent(
  options: CreateTrueForgePlanningAgentOptions,
): Promise<{ planner: TrueForgeAuditPlanningAgent; modelProfileId: string }> {
  const model = options.model?.trim();
  if (!model) throw new Error('VERIFIAI_TRUEFORGE_MODEL is required when VERIFIAI_AGENT_HARNESS=trueforge');
  const client = new TrueForgeHarnessClient({
    baseUrl: options.baseUrl,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  await client.health();
  return {
    planner: new TrueForgeAuditPlanningAgent(client, model, options.timeoutMs ?? 180_000),
    modelProfileId: `trueforge:${model}`,
  };
}
