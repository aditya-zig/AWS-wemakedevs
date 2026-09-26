# TrueForge Harness Migration

Branch: `trueforge-harness-migration`

Upstream harness: https://github.com/truefoundry/trueforge

This branch is intentionally isolated from the friend's active local E2E checkout. Do not merge it into that checkout until the migration gate below passes.

## Goal

Replace the Strands agent loop with TrueForge while preserving VERIFAI's existing product contracts:

- repository/target lifecycle
- audit API and UI
- specialist roles
- spend/time/concurrency guardrails
- evidence normalization and ownership
- real upstream engines
- truthful Confirmed / Unconfirmed / Unknown / Incomplete states

TrueForge owns the agent harness: model sessions, turns, MCP connectors, optional sandbox, context management and future subagent capabilities.

## Current migration status

Implemented on this branch:

- `VERIFIAI_AGENT_HARNESS=trueforge|strands`
- TrueForge REST/SSE client with no new npm dependency
- TrueForge-backed audit planner
- TrueForge-backed worker launcher
- TrueForge model credentials remain configured in TrueForge
- existing VERIFAI audit contracts and guardrails are preserved
- actual TrueForge `tool.response` events are recorded as executed runtime evidence
- model-only claims cannot promote themselves to Confirmed
- Strands/AgentCore remains a rollback path while parity is being tested

Not yet complete:

- VERIFAI-specific external-engine tools are not yet exposed to TrueForge through a scoped MCP bridge
- Browser Use/Cua/k6/Strix/ZAP/etc. therefore remain Incomplete on the TrueForge path unless an already-configured TrueForge MCP connector genuinely provides that capability
- no claim of local E2E PASS has been made for this migration branch
- Strands dependencies have not been deleted yet; remove them only after TrueForge parity + two complete UI audits

## Local TrueForge setup

TrueForge requires Node 22+.

Quick local server:

```bash
npx @truefoundry/trueforge
```

Default local API/UI origin:

```text
http://127.0.0.1:8790
```

Check:

```bash
curl -fsS http://127.0.0.1:8790/healthz
```

After the VERIFAI environment variables are set, run the no-generation preflight:

```bash
npm run verify:trueforge
```

It verifies harness selection, required model name, TrueForge reachability and auth mode without making a model generation request.

In TrueForge:

1. Open Settings -> Models.
2. Configure the model/provider using the API key already present on the machine.
3. Note the exact configured model name.
4. Open Settings -> Connectors.
5. Confirm only the MCP connectors VERIFAI should be allowed to use.
6. Keep TrueForge local-only unless login/network hardening is intentionally configured.
7. Configure a sandbox provider only if VERIFAI will enable TrueForge sandbox mode.

Do not copy provider secrets from TrueForge into Git, Notion, screenshots or VERIFAI config.

## VERIFAI environment

Minimum:

```bash
VERIFIAI_AGENT_HARNESS=trueforge
VERIFIAI_TRUEFORGE_BASE_URL=http://127.0.0.1:8790
VERIFIAI_TRUEFORGE_MODEL=<exact model name configured in TrueForge>
VERIFIAI_TRUEFORGE_TIMEOUT_MS=180000
```

If the TrueForge server uses OIDC login:

```bash
VERIFIAI_TRUEFORGE_TOKEN=<short-lived OIDC ID token>
```

Optional MCP connectors already registered in TrueForge:

```bash
VERIFIAI_TRUEFORGE_MCP_SERVERS=github,<other-scoped-connector>
VERIFIAI_TRUEFORGE_REQUIRE_APPROVAL_FOR_TOOLS=@destructive
```

Optional sandbox:

```bash
VERIFIAI_TRUEFORGE_SANDBOX=true
```

Only set sandbox=true after a TrueForge sandbox provider is actually configured.

## Start order

1. Start TrueForge.
2. Confirm `/healthz`.
3. Start only the VERIFAI services needed for the current local E2E path.
4. Start the audited target.
5. Open the VERIFAI web UI.
6. Submit one small real audit first.
7. Inspect TrueForge Sessions and VERIFAI audit evidence together.
8. Only after the small audit works, attempt the full two-audit local gate.

## What changes in execution

Before:

```text
VERIFAI API
  -> Strands planner
  -> Docker/AgentCore Strands worker
  -> VERIFAI worker tools
  -> external engines
```

Migration branch:

```text
VERIFAI API
  -> TrueForge planner session
  -> TrueForge worker session
  -> configured TrueForge MCP connectors / optional sandbox
  -> VERIFAI evidence normalizer
```

Target creation, reports, audit state, guardrails and evidence ownership remain VERIFAI responsibilities.

## Important evidence rule

A language-model answer is never enough for Confirmed.

The TrueForge launcher records real `tool.response` events. Generic connector output is treated as executed but outcome=unknown unless it contains a valid structured VERIFAI evidence object.

A worker requesting `Confirmed` is downgraded to `Unconfirmed` unless real executed non-LLM evidence has outcome=fail.

This rule must not be weakened during migration.

## Required next implementation: VERIFAI MCP bridge

The migration is not tool-parity complete until TrueForge can call the same real VERIFAI capabilities the Strands worker used.

Expose a scoped remote MCP server from VERIFAI with tools equivalent to the currently approved worker capabilities, for example:

- `repo_tree`
- `repo_read`
- `target_http`
- `performance_probe`
- `mirofish_personas`
- `strix_scan`
- `zap_scan`
- `schemathesis_fuzz`
- `load_test`
- `toxiproxy_fault`
- Browser Use / Cua execution
- isolated mutation/repair tools

Requirements:

- worker/audit identity is bound server-side; do not trust arbitrary identity from model arguments
- preserve `maxToolCalls`, `maxEvidenceItems`, network allowlists, destructive permissions and spend limits
- return structured evidence generated by the real adapter, not model-authored evidence
- keep engine credentials in the engine/connector layer
- require authorization for mutation tools
- every external-engine result retains upstream/version/command/artifact provenance
- unavailable engines return Incomplete, never fake PASS

Recommended endpoint name: `verifiai-audit-tools`.

Once registered in TrueForge Settings -> Connectors:

```bash
VERIFIAI_TRUEFORGE_MCP_SERVERS=verifiai-audit-tools
```

For unattended read-only E2E, tool approvals may be loosened only on that dedicated scoped connector. Do not globally disable approvals on personal GitHub/Notion/admin connectors.

## Migration gate

Do not delete Strands yet.

TrueForge becomes the only harness after all of these are true:

- [ ] TrueForge health succeeds from VERIFAI
- [ ] planner returns a valid bounded worker plan
- [ ] worker session streams real events
- [ ] dedicated VERIFAI MCP bridge is connected
- [ ] one real external engine executes through TrueForge
- [ ] Browser Use lane produces real screenshot/action evidence or is truthfully Incomplete
- [ ] k6/performance lane produces real metrics
- [ ] UI shows progress and terminal report
- [ ] restart + artifact ownership checks pass
- [ ] cleanup is verified
- [ ] audit 1 passes the full local gate
- [ ] audit 2 passes with a fresh audit/target
- [ ] final `npm run check` passes
- [ ] no secret appears in logs/UI/artifacts

Then:

1. record a rollback tag/branch;
2. remove `@strands-agents/sdk`;
3. delete Strands-only planner/worker code;
4. remove AgentCore worker runtime resources that are no longer used;
5. update architecture docs and AWS deployment docs to host/reach TrueForge appropriately;
6. rerun the full local gate and one credentialed cloud gate.

## Friend laptop rule

The friend's current E2E work is the baseline, not the migration workspace.

Do not ask the friend to switch branches mid-run. Finish and record the current baseline first. Then clone/check out this migration branch into a separate directory and compare:

```text
baseline E2E result
vs
TrueForge migration result
```

Never overwrite the working transferred checkout or its local evidence.

## Rollback

Temporary rollback only:

```bash
VERIFIAI_AGENT_HARNESS=strands
```

The rollback exists to compare behavior during migration. New architecture work should target TrueForge.
