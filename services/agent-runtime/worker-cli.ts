import {
  AGENT_WORKER_CONTRACT_VERSION,
  assertAgentWorkerLaunchBrief,
  type AgentWorkerEvent,
  type AgentWorkerLaunchBrief,
} from '../../packages/contracts/src/index.js';
import { executeAgentCoreWorker } from './worker-server.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let brief: AgentWorkerLaunchBrief | undefined;

try {
  const body = JSON.parse(await readStdin());
  if (body?.type !== 'verifiai.worker.launch') throw new Error('unsupported invocation type');
  brief = body.brief;
  assertAgentWorkerLaunchBrief(brief);

  const report = await executeAgentCoreWorker(brief, async (event: AgentWorkerEvent) => {
    write({ type: 'worker.event', event });
  });
  write({ type: 'worker.report', report });
} catch (error: any) {
  const message = String(error?.message ?? error);
  if (brief) {
    write({
      type: 'worker.report',
      report: {
        contractVersion: AGENT_WORKER_CONTRACT_VERSION,
        auditId: brief.auditId,
        workerId: brief.workerId,
        role: brief.role,
        outcome: 'incomplete',
        findingState: 'Incomplete',
        summary: 'Local Docker worker crashed before completing its assignment.',
        findings: [],
        evidence: [],
        evidenceRefs: [...brief.evidenceRefs],
        followUps: [],
        error: message,
      },
    });
  } else {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
