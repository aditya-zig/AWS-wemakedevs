import type {
  AgentToolGrant,
  AgentWorkerLauncher,
  AuditRepositoryFacts,
  AuditTargetRef,
} from '../../../packages/contracts/src/index.js';
import { AgentCoreWorkerLauncher } from '../../../services/agent-runtime/agentcore-launcher.js';
import { DockerWorkerLauncher } from '../../../services/agent-runtime/docker-launcher.js';
import {
  HttpProofRecorder,
  HttpRegressionRunner,
  RepairImprovementFlow,
  TargetHealthProbe,
  type RepairFlowResult,
  type RepairSource,
} from '../../../services/agents/repair/repair-flow.js';

export interface LiveRepairContext {
  auditId: string;
  repository: AuditRepositoryFacts;
  modelProfileId: string;
  networkAllowlist: string[];
}

export interface LiveRepairInput extends LiveRepairContext {
  mutableTarget: AuditTargetRef;
  source: RepairSource;
  reverificationTools?: AgentToolGrant[];
}

export interface LiveRepairServiceOptions {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
}

function endpointHost(value: string | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).hostname; } catch { return null; }
}

export class LiveRepairService {
  private readonly env: Record<string, string | undefined>;
  private readonly fetchFn: typeof fetch;

  constructor(options: LiveRepairServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  missingConfiguration(visibleChange: boolean): string[] {
    const missing: string[] = [];
    if (!this.env.VERIFIAI_MUTATION_SERVICE_URL) missing.push('VERIFIAI_MUTATION_SERVICE_URL');
    if (!this.env.VERIFIAI_REGRESSION_SERVICE_URL) missing.push('VERIFIAI_REGRESSION_SERVICE_URL');
    if (visibleChange && !this.env.VERIFIAI_PROOF_RECORDER_URL) missing.push('VERIFIAI_PROOF_RECORDER_URL');
    const mode = this.env.VERIFIAI_EXECUTION_MODE ?? 'local';
    if (mode === 'agentcore' && !this.env.VERIFIAI_AGENTCORE_RUNTIME_ARN) missing.push('VERIFIAI_AGENTCORE_RUNTIME_ARN');
    return missing;
  }

  async run(input: LiveRepairInput): Promise<RepairFlowResult> {
    if (input.mutableTarget.environment !== 'isolated-mutation') {
      throw new Error('mutableTarget.environment must be isolated-mutation');
    }
    const missing = this.missingConfiguration(input.source.visibleChange);
    if (missing.length) throw new Error(`repair runtime is not configured: ${missing.join(', ')}`);

    const mode = this.env.VERIFIAI_EXECUTION_MODE ?? 'local';
    if (mode !== 'local' && mode !== 'agentcore') throw new Error('VERIFIAI_EXECUTION_MODE must be local or agentcore');

    let launcher: AgentWorkerLauncher;
    if (mode === 'agentcore') {
      launcher = new AgentCoreWorkerLauncher({
        defaultRuntime: {
          region: this.env.AWS_REGION ?? 'us-west-2',
          runtimeArn: this.env.VERIFIAI_AGENTCORE_RUNTIME_ARN!,
        },
      });
    } else {
      launcher = new DockerWorkerLauncher({
        image: this.env.VERIFIAI_LOCAL_WORKER_IMAGE,
        cpus: Number(this.env.VERIFIAI_LOCAL_WORKER_CPUS ?? 1),
        memory: this.env.VERIFIAI_LOCAL_WORKER_MEMORY ?? '1024m',
        pidsLimit: Number(this.env.VERIFIAI_LOCAL_WORKER_PIDS ?? 256),
        network: this.env.VERIFIAI_LOCAL_WORKER_NETWORK ?? 'bridge',
        env: this.env,
      });
    }

    const proofRecorder = input.source.visibleChange
      ? new HttpProofRecorder(
          this.env.VERIFIAI_PROOF_RECORDER_URL!,
          this.env.VERIFIAI_PROOF_RECORDER_TOKEN,
          this.fetchFn,
        )
      : {
          async capture(): Promise<never> {
            throw new Error('proof recorder is not invoked for an invisible change');
          },
        };

    const flow = new RepairImprovementFlow(
      launcher,
      new TargetHealthProbe(this.fetchFn),
      new HttpRegressionRunner(
        this.env.VERIFIAI_REGRESSION_SERVICE_URL!,
        this.env.VERIFIAI_REGRESSION_SERVICE_TOKEN,
        this.fetchFn,
      ),
      proofRecorder,
    );

    const allowlist = new Set(input.networkAllowlist);
    for (const value of [
      input.mutableTarget.url,
      this.env.VERIFIAI_MUTATION_SERVICE_URL,
      this.env.VERIFIAI_REGRESSION_SERVICE_URL,
      this.env.VERIFIAI_PROOF_RECORDER_URL,
      this.env.VERIFIAI_EXTERNAL_ENGINE_URL,
      this.env.VERIFIAI_BROWSER_USE_URL,
      this.env.VERIFIAI_CUA_URL,
      this.env.VERIFIAI_COMPUTER_USE_URL,
    ]) {
      const host = endpointHost(value);
      if (host) allowlist.add(host);
    }

    return flow.run({
      auditId: input.auditId,
      repository: input.repository,
      mutableTarget: input.mutableTarget,
      modelProfileId: input.modelProfileId,
      networkAllowlist: [...allowlist],
      source: input.source,
      reverificationTools: input.reverificationTools,
    });
  }
}
