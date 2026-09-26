# VERIFAI coding-agent rules

The current AWS Hackathon, **VERIFAI — Grill with Docs**, **VERIFAI — Master Execution & E2E Status**, and **TrueForge Harness Migration** Notion pages are the product/architecture source of truth. On branch `trueforge-harness-migration`, TrueForge is the target agent harness. Strands + AgentCore remain only as a temporary rollback path until TrueForge reaches tool/evidence parity and passes the local E2E gate.

## External engines: upstream-first, no substitutes

When a task names MiroFish, Strix, Cua, Browser Use, OWASP ZAP, Schemathesis, Locust, k6, or Toxiproxy:

1. Read `config/external-engines.json`.
2. Run `node scripts/clone-external-engines.mjs <engine-id>` before writing the adapter. Inspect the pinned upstream source, docs, actual entrypoints, API and output format.
3. Use the real upstream project. Keep the VERIFAI adapter thin: start/connect -> execute upstream capability -> capture upstream output/artifacts -> normalize evidence -> stop.
4. Do not implement a "compatible" replacement, hard-coded simulation, fake screenshot, fake security PASS, in-memory fake network fault, guessed CLI, or custom load tester and label it as the named engine.
5. If the upstream engine cannot run, return **Incomplete** with the exact reason. Never turn absence of a real engine into PASS.
6. Every named-engine evidence item must identify the upstream repo, pinned commit/version, real command/API invocation, exit/result status, and artifact references.
7. Do not copy third-party source into VERIFAI core. Keep clones under `.external/` and out of Git. Runtime can use a pinned official package/image when appropriate.
8. MiroFish and k6 are AGPL components in this plan: keep them as separate services/containers. Preserve all required notices/source obligations. Cua's optional `[omni]` dependency has separate AGPL implications and is not enabled by default.
9. Do not declare an integration done merely because an adapter, Dockerfile, mock, test fixture, or UI label exists. Done means a clean run invoked the real upstream engine and captured real artifacts.
10. Before pushing, run the relevant real-engine acceptance check. If credentials/infrastructure prevent that check, leave the task explicitly incomplete rather than adding synthetic proof.

## Current known legacy violations

The legacy deterministic Deep Audit contains synthetic/compatibility paths such as Strix/Cua fallbacks, hard-coded MiroFish persona outcomes, and in-memory chaos records. Treat these as migration debt, not valid proof that those upstream engines are integrated.

New work must remove/replace those paths, not build more features on top of them.


## TrueForge migration rules

1. Do not modify or rebase the friend's active local E2E checkout from this branch.
2. Default `VERIFIAI_AGENT_HARNESS=trueforge` on this migration branch. Use `strands` only to compare behavior or unblock rollback.
3. TrueForge owns the model/agent loop. VERIFAI keeps repository/target lifecycle, guardrails, evidence normalization, authorization, external-engine truthfulness and audit UI contracts.
4. Model/API credentials configured in TrueForge stay in TrueForge. Do not duplicate those secrets into VERIFAI unless an external engine independently requires them.
5. Attach only explicitly named TrueForge MCP connectors. Destructive tools require approval by default.
6. A TrueForge tool event is not automatically a confirmed finding. VERIFAI may mark a finding Confirmed only when executed evidence demonstrates failure.
7. The remaining parity blocker is the VERIFAI tool bridge: Browser Use/Cua/k6/Strix/etc. must be exposed to TrueForge through scoped MCP connectors or equivalent real upstream interfaces. Until then those lanes are Incomplete, never silently simulated.
8. Remove `@strands-agents/sdk`, Strands worker runtime code and AgentCore worker-only infrastructure only after two complete UI audits pass on the TrueForge path and the rollback branch/tag is recorded.
