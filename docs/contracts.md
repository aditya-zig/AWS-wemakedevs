# VERIFIAI frozen contracts

Hackathon freeze: 2026-09-17. Shared names in `packages/contracts/src/index.ts` are owned by Aditya. Other lanes should request changes instead of editing this package directly.

## Core entities

`Project` → imported GitHub repository pinned to `branch` + `commitSha`.

`Requirement` → stable ID, source text, executable invariants, experiment types and target tools.

`Experiment` → one executable verification step with `pending | running | pass | fail | unknown` state. `unknown` is never treated as failure.

`Evidence` → an observation produced by actual execution. `executed=false` or `source=llm` cannot independently verify a requirement.

`Finding` → hypothesis/tested/confirmed/rejected investigation result tied to evidence.

`Repair` → branch + patch + before/after evidence-backed verdict.

`VerificationRun` → complete experiment state, evidence, events and status counts.

## VerificationTool adapter

Every external engine (Cua, Strix, MiroFish, API/performance, chaos) implements one boundary:

```ts
interface VerificationTool {
  name: ToolName | string;
  capabilities: string[];
  healthcheck(): Promise<{ ok: boolean; detail?: string }>;
  prepare(context?: { target: Record<string, unknown>; environment: Record<string, unknown> }): Promise<void>;
  execute(experiment: Experiment): Promise<{
    status: 'pass' | 'fail' | 'unknown';
    observations?: string[];
    evidence: EvidenceInput[];
  }>;
  stop(): Promise<void>;
  evidence(): Promise<EvidenceInput[]>;
  artifacts(): Promise<string[]>;
}
```

Tools perform experiments. VERIFIAI owns orchestration, verdicts, evidence linkage and re-verification.

## Evidence rule

A PASS from model text alone is not verification. The judge only returns `VERIFIED` when every relevant experiment has `status=pass` plus executed, non-LLM evidence whose payload reports `outcome=pass`. Executed failing evidence yields `FAILED`; everything insufficient remains `UNKNOWN`.
