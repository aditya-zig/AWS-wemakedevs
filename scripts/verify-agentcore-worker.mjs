import { AgentCoreWorkerLauncher } from '../dist/services/agent-runtime/agentcore-launcher.js';
import { AGENT_WORKER_CONTRACT_VERSION } from '../dist/packages/contracts/src/index.js';

const runtimeArn = process.env.VERIFIAI_AGENTCORE_RUNTIME_ARN;
const modelProfileId = process.env.VERIFIAI_AGENTCORE_MODEL_PROFILE;
if (!runtimeArn) throw new Error('VERIFIAI_AGENTCORE_RUNTIME_ARN is required');
if (!modelProfileId) throw new Error('VERIFIAI_AGENTCORE_MODEL_PROFILE is required');

const region = process.env.AWS_REGION || 'ap-south-1';
const auditId = `AUD-LIVE-${Date.now()}`;
const workerId = `security-secrets-live-${Date.now()}`;
const events = [];
const launcher = new AgentCoreWorkerLauncher({
  defaultRuntime: { region, runtimeArn },
});
const session = await launcher.launch({
  contractVersion: AGENT_WORKER_CONTRACT_VERSION,
  auditId,
  workerId,
  role: 'security-secrets',
  objective: 'Prove the real AgentCore + Strands worker lifecycle. Do not claim executed findings; return scoped lifecycle analysis only.',
  repository: {
    provider: 'github',
    fullName: 'aditya-zig/AWS-wemakedevs',
    url: 'https://github.com/aditya-zig/AWS-wemakedevs',
    branch: 'main',
    commitSha: process.env.GITHUB_SHA || 'manual-smoke',
  },
  target: null,
  tools: [],
  evidenceRefs: [],
  modelProfileId,
  constraints: {
    timeoutMs: 120000,
    maxToolCalls: 4,
    maxEvidenceItems: 20,
    destructiveAllowed: false,
    networkAllowlist: [],
    maxEstimatedSpendUsd: 0.25,
  },
}, async event => events.push(event));

const report = await session.result;
await launcher.teardown(session);
if (report.outcome !== 'completed') throw new Error(`AgentCore worker incomplete: ${report.error || report.summary}`);
if (!events.some(event => event.phase === 'running')) throw new Error('missing running event');
if (!events.some(event => event.phase === 'tearing_down')) throw new Error('missing teardown event');
console.log(JSON.stringify({
  verified: true,
  auditId,
  workerId,
  sessionId: session.sessionId,
  role: report.role,
  outcome: report.outcome,
  findingState: report.findingState,
  eventPhases: events.filter(event => event.type === 'worker.status').map(event => event.phase),
}));
