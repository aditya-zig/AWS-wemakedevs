# VERIFAI frozen contracts

Architecture freeze: 2026-09-18. The newer **Grill with Docs** decisions supersede the 17 Sep deterministic-agent design.

## Execution boundary

There are now two explicit execution classes:

1. **Real workers** — model-backed Strands agents launched in isolated AgentCore sessions.
2. **Deterministic tools** — existing adapters/runners used by workers for execution, evidence capture and replayable regression checks.

A deterministic runner is never an autonomous agent and must not be presented as one.

## Real worker lifecycle

Every worker uses the same contract from `packages/contracts/src/index.ts`:

```text
structured launch brief
→ launch isolated worker
→ direct approved tool use
→ stream status + executed evidence
→ structured report / follow-up request
→ teardown
```

The launch brief pins the repository commit, target environment, role, approved tools, evidence references, model profile and hard limits. Workers do not communicate peer-to-peer. The audit orchestrator owns the living plan and persistent audit state.

Baseline roles are:

- security/secrets
- browser/app-user
- API/chaos
- performance/discovery

Dynamic roles are hypothesis, investigator, judge, repair and independent re-verification.

## Deterministic VerificationTool adapter

Existing engines remain useful behind one boundary:

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

The old `VerificationOrchestrator` export is retained only as a compatibility alias for `DeterministicVerificationRunner`. New multi-agent code must not build on it.

## Evidence rule

A model assertion is not verification. PASS/FAIL and Confirmed/Unconfirmed/Unknown/Incomplete states must derive from executed evidence. Repair workers cannot verify their own patches; verification is independent.
