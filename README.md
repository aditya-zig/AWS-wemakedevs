# VERIFIAI

Autonomous Software Verification Lab for the WeMakeDevs AWS Hackathon.

VERIFIAI turns requirements into real experiments, executes them through isolated verification tools, records reproducible evidence, investigates failures, applies repairs in a controlled branch and reruns the same verification before changing a requirement to **VERIFIED**.

## Current core

Aditya-owned core implemented here:

- shared contracts for Project, Requirement, Experiment, Evidence, Finding, Repair and VerificationRun
- frozen `VerificationTool` adapter boundary for the other implementation lanes
- GitHub OAuth state validation, repository/branch listing and commit-pinned project import
- persistent project metadata without storing OAuth tokens
- deterministic requirement parsing + verification planning
- verification orchestrator with pass/fail/unknown state machine and run events
- evidence graph persistence
- investigator + evidence-only judge
- controlled repair + re-verification loop
- HTTP endpoints for setup, planning and verification runs
- executable flagship fixture: payment-provider latency → failure → root cause → repair → verified

## Deep Audit default

The hackathon demo now starts in **Deep Audit** by default. One run coordinates security, leakage, API, browser-use, computer-use, customer simulation, chaos and performance checks, then optionally tests a deployed URL and installable app.

It includes per-engine retries and failure isolation; Confirmed / Unconfirmed / Unknown / Incomplete verdicts; live run state; ephemeral credential redaction; hard request, duration and estimated-cost caps under the $100 credit ceiling; commit-pinned verified knowledge; and a gated reproduce → sandbox patch → regression → proof → PR-ready flow with no auto-merge.

Demo API:

- POST /api/demo/deep-audit
- GET /api/demo/deep-audit/:runId
- POST /api/demo/deep-audit/:runId/steer
- POST /api/demo/deep-audit/:runId/pr

## Run locally

Requires Node.js 22+ and TypeScript 5.8+.

```bash
npm run check
cp .env.example .env
# fill GitHub OAuth values
npm run build
npm run start:api
```

API defaults to `http://localhost:8787`.

## Main API

- `GET /health`
- `POST /api/github/oauth/start`
- `POST /api/github/oauth/callback`
- `GET /api/github/repositories?sessionId=...`
- `GET /api/github/repositories/:owner/:repo/branches?sessionId=...`
- `POST /api/projects/import`
- `POST /api/requirements/parse`
- `POST /api/plans`
- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`

## Repository ownership during hackathon

| Owner | Paths |
|---|---|
| Aditya | `apps/api/`, `packages/core/`, `packages/contracts/`, root/shared config |
| Mrudul | `services/sandbox/`, `infra/`, `packages/observability/` |
| Movya | `apps/web/` |
| Amit | `services/integrations/`, `packages/adapters/`, integration fixtures |

Do not commit secrets. External verification engines stay behind the frozen adapter contract; they do not become dependencies of core internals.

See `docs/contracts.md` for the shared interface freeze.
