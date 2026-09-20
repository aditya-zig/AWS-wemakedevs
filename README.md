<div align="center">

# VERIFAI

### Autonomous Software Verification Lab

**Connect a repo. Let AI agents test it like the real world will. See the evidence.**

VERIFAI turns a GitHub repository into an evidence-backed verification run: it discovers how the software starts, plans a Deep Audit, launches isolated AI workers and real verification engines, records what actually happened, investigates conflicting signals, and re-verifies repairs before they become PR-ready.

> **Demo media:** no real VERIFAI product recording is committed yet. This README deliberately does not embed synthetic footage, placeholder binaries, or fake evidence. Use the [45–60 second real-recording guide](docs/demo-video.md); once real footage exists, the hero can be activated with <code>assets/verifai-intro.gif</code> and <code>assets/verifai-intro.mp4</code>.

[Demo recording guide](docs/demo-video.md) · [How it works](#how-it-works) · [Quickstart](#quickstart) · [Architecture](#architecture)

[![VERIFAI CI](https://github.com/aditya-zig/AWS-wemakedevs/actions/workflows/ci.yml/badge.svg)](https://github.com/aditya-zig/AWS-wemakedevs/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-CodeBuild%20%7C%20ECR%20%7C%20Fargate-232F3E?logo=amazonaws&logoColor=white)
![Strands](https://img.shields.io/badge/Strands-Agents-5B5BD6)
![License](https://img.shields.io/badge/license-not%20declared-lightgrey)

</div>

---

## The 30-second explanation

Modern apps can have green unit tests and still fail where users actually experience them: repository bootstrap, authentication, browser flows, API contracts, secrets exposure, dependency latency, performance, or a repair that fixes one problem while creating another.

VERIFAI runs an evidence-first loop around those gaps.

~~~text
GitHub repository
    ↓
Discovery + bootstrap
    ↓
Strands planning/orchestration
    ↓
Isolated specialist workers
    ↓
Real verification engines
    ↓
Executed evidence
    ↓
Confirmed / Unconfirmed / Unknown / Incomplete
    ↓
Independent investigation / judge
    ↓
Isolated repair
    ↓
Re-verification + regressions
    ↓
PR-ready only when proven
~~~

**Core rule:** model output is not verification. Confidence comes from executed evidence, not from an agent saying something looks correct.

---

## Try VERIFAI

The intended product journey is one continuous audit:

1. **Connect a GitHub repository.** VERIFAI records the branch and resolves the exact commit used by the run.
2. **Discover the app.** It inspects manifests, README/docs, build/start commands, URLs, schemas and likely verification surfaces.
3. **Bootstrap the target.** Local runs use isolated workers; the AWS path builds through CodeBuild, stores images in ECR and launches a bounded Fargate target.
4. **Plan the Deep Audit.** A Strands planning agent assigns specialist work from the repository, target and objective.
5. **Run real verification engines.** Security, API, browser/computer-use, user-simulation, chaos and performance tools run only when applicable and configured.
6. **Collect evidence.** Logs, responses, screenshots, traces, metrics, engine output and reproduction details are attached to the run.
7. **Investigate uncertainty.** Suspicious or conflicting results can fan out to independent investigators/judges.
8. **Propose a repair.** Repair happens on an isolated mutable target; VERIFAI does not auto-merge <code>main</code>.
9. **Re-run the failure and regressions.** A plausible patch is not a successful fix until independent verification proves the behavior.
10. **Return a reviewable result.** The user can see what ran, what did not run, the evidence behind each finding, and whether a repair is genuinely PR-ready.

### Evidence states

| State | Meaning |
| --- | --- |
| **Confirmed** | Sufficient executed evidence supports the claim—for example, a defect is reproducibly observed or a behavior is independently proven. |
| **Unconfirmed** | A signal exists, but reproduction or an independent cross-check conflicts with it. |
| **Unknown** | Checks ran, but the available evidence is insufficient to decide. Unknown is neither success nor failure. |
| **Incomplete** | A required check could not finish because of bootstrap, runtime, credentials, networking, timeout or an unavailable engine. Incomplete is never converted into a fake pass. |

---

## Why VERIFAI exists

AI-assisted and vibe-coded software can be created quickly, but that speed moves risk downstream. Generated code can satisfy a narrow prompt and still fail under real release conditions.

Traditional tests remain essential, but they usually answer questions the repository already knew to ask. VERIFAI adds another layer:

- Can the repo build and start from a clean environment?
- Does a deployed app behave like the source build?
- Can a real browser/computer-use agent complete important journeys?
- Do API contracts survive generated edge cases?
- Are secrets or sensitive configuration exposed?
- What happens when a dependency becomes slow or unreliable?
- Does performance degrade under bounded load?
- Can independent evidence reproduce a suspicious finding?
- Does a proposed repair solve the original problem without an unacceptable regression?

VERIFAI complements unit, integration and end-to-end tests; it does not replace them.

---

## How it works

### Architecture

~~~mermaid
flowchart LR
    UI[VERIFAI Web UI] --> API[VERIFAI API]
    API --> ORCH[Strands orchestrator]

    ORCH --> PLAN[Repository discovery + audit plan]
    PLAN --> BOOT[Target bootstrap]
    BOOT --> CB[AWS CodeBuild]
    CB --> ECR[Amazon ECR]
    ECR --> FARGATE[Bounded Fargate target]

    ORCH --> WORKERS[AgentCore / isolated specialist workers]
    WORKERS --> ENGINES[Real verification engines]
    FARGATE --> ENGINES

    ENGINES --> EVIDENCE[Evidence + artifacts]
    WORKERS --> EVIDENCE
    EVIDENCE --> JUDGE[Independent investigation / judge]
    JUDGE --> REPORT[Combined findings]

    REPORT --> REPAIR[Separate repair agent]
    REPAIR --> MUTABLE[Isolated mutable target]
    MUTABLE --> REVERIFY[Targeted re-verification + regressions]
    REVERIFY --> EVIDENCE
    REVERIFY --> PR[PR-ready package when proven]
~~~

Workers may reason, but tools execute checks and evidence determines the final state.

### Real verification engines

External projects stay behind adapter/service boundaries. VERIFAI expects the real upstream tool; an unavailable runtime becomes **Incomplete**, never a mocked PASS.

| Engine | Use | Applicability | Current truth |
| --- | --- | --- | --- |
| **Strix** | Security/adversarial verification | Security inspection | Pinned upstream integration path exists; real runtime/model configuration is required for executed proof. |
| **OWASP ZAP** | Dynamic web security scanning | Reachable HTTP/web targets | Docker service exists; a real scan report is required before claiming execution. |
| **Schemathesis** | Property-based API testing | Discovered OpenAPI/GraphQL schemas | Pinned upstream path exists; inapplicable when no compatible schema is found. |
| **Browser Use** | Browser-specialized user journeys | Web UI flows | Real service boundary exists; requires a model endpoint/key and reachable target. |
| **Cua** | Computer-use/visual workflows | Desktop/browser/app journeys | Real pinned Cua runtime; heavy/unreachable local setups should remain Incomplete rather than block all verification. |
| **MiroFish** | Persona/user simulation | Customer-behavior experiments | Requires its real backend/model configuration; demo policy caps persona fan-out. |
| **Locust** | Bounded load/performance | HTTP/application load | Real headless execution is expected with exported stats. |
| **k6** | Deterministic load/replay | Repeatable performance scenarios | Pinned separate upstream component; real execution evidence is required. |
| **Toxiproxy** | Latency/failure injection | Dependencies routed through the proxy | Real proxy + toxic API; meaningful only when target traffic actually passes through it. |

Pinned repositories, revisions and license boundaries are in [<code>config/external-engines.json</code>](config/external-engines.json).

---

## What is real vs. incomplete

### Implemented on <code>main</code>

- GitHub + Google OAuth/session code with validated state and HttpOnly cookies.
- Repository/branch discovery and commit-pinned project import.
- Requirement, plan, evidence, finding, repair and run contracts.
- Strands-based planning/orchestration and specialist-worker contracts.
- Local Docker-worker and AWS AgentCore launch paths.
- CodeBuild/ECR/Fargate target lifecycle and teardown handling.
- Real external-engine configuration and adapter/service boundaries.
- Explicit Confirmed / Unconfirmed / Unknown / Incomplete states.
- Independent follow-up investigation and bounded retries.
- Separate repair/re-verification service boundaries with PR gating.
- Web UI, API, tests and GitHub Actions CI.

### Not claimed as complete proof

- **A11 live AWS run:** no accepted credentialed Twenty/Cal.diy CodeBuild → ECR → Fargate → AgentCore/engine proof yet.
- **A12 repeated demo hardening:** blocked until A11 produces real cloud artifacts and teardown evidence.
- **Every external engine running locally:** not claimed; heavy or unavailable lanes may truthfully finish Incomplete.
- **Real demo GIF/MP4:** not committed yet.
- **PR #7 / PR #8 behavior:** both are open and unmerged, so this README does not present their changes as current <code>main</code> behavior.

A green CI run proves repository checks. It does **not** prove a live AWS audit or every external engine executed.

---

## Current implementation

| Layer | Location |
| --- | --- |
| Product UI | <code>apps/web/</code> |
| HTTP API + auth | <code>apps/api/</code> |
| Shared contracts/core | <code>packages/contracts/</code>, <code>packages/core/</code> |
| Strands orchestration | <code>services/orchestrator/</code> |
| Agent runtime | <code>services/agent-runtime/</code> |
| Verification adapters | <code>packages/adapters/</code>, <code>services/integrations/</code> |
| Repository/bootstrap lifecycle | <code>services/bootstrap/</code> |
| Sandbox/target execution | <code>services/sandbox/</code>, <code>infra/local/</code>, <code>infra/aws/</code> |
| Deep Audit compatibility path | <code>services/deep-audit/</code> |
| CI/release verification | <code>.github/workflows/</code>, <code>tests/</code>, <code>tests-p0/</code>, <code>tests-p1/</code>, <code>scripts/</code> |

See [<code>docs/contracts.md</code>](docs/contracts.md) for the current execution/evidence boundary.

---

## Safety and resource boundaries

Cloud execution is intentionally bounded:

- **One VERIFAI-managed Fargate target task maximum.**
- **Default Fargate size:** 0.5 vCPU / 1 GB RAM (<code>512</code> CPU units / <code>1024</code> MiB).
- **Hard audit ceiling:** at most **20 minutes**; a run may be configured lower.
- **Automatic worker retry:** maximum **1** retry.
- **MiroFish demo policy:** maximum **5 personas**.
- **Cleanup:** tasks are stopped and ephemeral task definitions deregistered during teardown/startup failure handling.
- **No auto-merge:** repairs become PR-ready only after targeted verification/regression checks.
- **Ephemeral secrets:** credentials stay outside Git and should be redacted from evidence.
- **No fake success:** unavailable engines, missing credentials and ambiguous bootstrap states remain Incomplete/Unknown.
- **Cost controls:** no always-on ECS service, NAT Gateway, RDS, EKS or unnecessary load balancer is required for the bounded demo path.

The optional local external-engine Compose stack has its own per-service CPU/memory caps. Do not start every heavy engine just to prove the UI works.

---

## Quickstart

This section describes the current <code>main</code> branch.

### Prerequisites

- Node.js **22+**
- npm
- Git
- Docker, for real local workers/external engines
- curl, for the first direct API audit
- GitHub + Google OAuth application values required by the current API entrypoint
- A supported model-provider credential for a real Strands audit

### 1. Clone and install

~~~bash
git clone https://github.com/aditya-zig/AWS-wemakedevs.git
cd AWS-wemakedevs
npm install --no-audit --no-fund
~~~

### 2. Create and load environment configuration

~~~bash
cp .env.example .env
~~~

The Node entrypoint does **not** auto-load <code>.env</code>. Export it in each shell that starts VERIFAI:

~~~bash
set -a
source .env
set +a
~~~

#### Required by the current API process

Fill these with your own values; never commit them:

~~~text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_CALLBACK_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL
VERIFIAI_STATE_SECRET
~~~

The example callback URLs already target the local API. Use valid provider values if you intend to exercise the OAuth flows.

#### Required for a real local Strands audit

Select a provider/model and the matching credential:

~~~text
VERIFIAI_MODEL_PROVIDER
VERIFIAI_MODEL_ID
OPENROUTER_API_KEY
# or NVIDIA_API_KEY / OLLAMA_API_KEY for supported alternatives
~~~

Optional engine-specific variables are documented in [<code>.env.example</code>](.env.example).

Local <code>main</code> launches workers from <code>verifiai-agent-worker:local</code> by default. Build and smoke-check that path with:

~~~bash
npm run verify:local-worker
~~~

### 3. Build/check

~~~bash
npm run check
~~~

This runs external-engine policy checks, TypeScript verification/build, the main tests, P0/P1 tests and the deterministic demo E2E guard.

### 4. Start API + web

**Terminal 1 — API**

~~~bash
set -a; source .env; set +a
npm run build
npm run start:api
~~~

Expected:

~~~text
VERIFAI API listening on :8787
~~~

**Terminal 2 — web**

~~~bash
set -a; source .env; set +a
npm run start:web
~~~

Expected:

~~~text
VERIFAI demo web: http://localhost:4173
~~~

Open **http://localhost:4173**.

### 5. Run the first real-swarm audit on current <code>main</code>

The current web and API are separate local servers. Until the pending local-routing work is merged, the most reliable first trigger is the API directly:

~~~bash
curl -sS -X POST http://localhost:8787/api/audits   -H 'content-type: application/json'   -d '{
    "repository": {
      "provider": "github",
      "fullName": "aditya-zig/AWS-wemakedevs",
      "url": "https://github.com/aditya-zig/AWS-wemakedevs",
      "branch": "main"
    },
    "target": null,
    "objective": "Run a Deep Audit and return only evidence-backed findings."
  }'
~~~

The API resolves the selected branch to an exact commit. Copy the returned <code>auditId</code>:

~~~bash
curl -sS http://localhost:8787/api/audits/<AUDIT_ID>/swarm
~~~

A correctly configured run should expose planned workers, events, executed evidence and a terminal <code>completed</code> or truthful <code>incomplete</code> result. Missing Docker images, model credentials or engines should remain visible instead of producing fabricated evidence.

### Stop / restart

Stop API and web with <code>Ctrl+C</code>.

If you started the full external-engine Compose stack:

~~~bash
npm run external:down
~~~

Restart with:

~~~bash
set -a; source .env; set +a
npm run start:api
~~~

~~~bash
set -a; source .env; set +a
npm run start:web
~~~

### Optional external engines

Clone one pinned engine when working on one lane:

~~~bash
npm run external:clone -- strix
~~~

Clone all pinned engines and start the full heavy Compose stack only when you actually need it:

~~~bash
npm run external:clone
npm run external:up
~~~

The stack is defined in [<code>docker-compose.external.yml</code>](docker-compose.external.yml).

### Troubleshooting <code>Incomplete</code>

| Symptom | Next check |
| --- | --- |
| API exits naming an OAuth variable | Fill/export the required API variables, then restart. |
| <code>Local Docker worker requires ...</code> | Configure the selected model-provider key or supported AWS Secrets Manager path. |
| <code>verifiai-agent-worker:local</code> is missing | Run <code>npm run verify:local-worker</code>. |
| Browser/Cua/ZAP/MiroFish is Incomplete | Start/configure only the required upstream service and check target/network reachability. |
| Bootstrap is Incomplete | VERIFAI could not infer enough build/start/health information; provide a supported repo setup/contract instead of guessing. |
| Audit times out | Keep the run inside configured guardrails; the hard ceiling is capped at 20 minutes. |

---

## Testing Twenty and Cal.diy

The intended A11/A12 recognizable real-repository targets are:

- **Twenty:** <code>twentyhq/twenty</code>
- **Cal.diy:** <code>calcom/cal.diy</code>

### Code support

Corrected repo-specific build/start/health support is under review in **PR #7**. Its repository CI is green, but it is still unmerged. Therefore those PR-specific details are **not** documented here as current <code>main</code> behavior.

PR #8 separately improves the local real-swarm startup/routing experience and also remains unmerged.

### AWS execution proof

No A11/A12 live AWS PASS is claimed.

A11 requires credentialed CodeBuild → ECR → bounded Fargate target → Strands/AgentCore → real-engine execution for **Twenty once and Cal.diy once**, with retained evidence and successful teardown.

A12 begins only after A11 passes with real cloud proof; it then repeats both targets to compare artifacts, cost/resource bounds and teardown stability before choosing the final demo candidate.

CI success, build support and health-check configuration are not substitutes for execution proof.

---

## Project structure

~~~text
AWS-wemakedevs/
├── apps/
│   ├── api/                 # auth, imports, audits, repair endpoints
│   └── web/                 # product UI
├── packages/
│   ├── adapters/            # engine adapters
│   ├── contracts/           # shared execution/evidence contracts
│   └── core/                # auth, import, planning/core services
├── services/
│   ├── agent-runtime/       # local Docker + AgentCore launchers
│   ├── agents/              # specialist policy
│   ├── bootstrap/           # discovery + AWS target lifecycle
│   ├── deep-audit/          # compatibility/demo path
│   ├── integrations/        # real integration boundaries
│   ├── orchestrator/        # Strands orchestration
│   └── sandbox/             # isolated runtime support
├── infra/
│   ├── aws/
│   └── local/
├── config/                  # pinned engines / E2E config
├── docs/
├── scripts/
├── tests/
├── tests-p0/
└── tests-p1/
~~~

---

## Documentation

- [<code>docs/contracts.md</code>](docs/contracts.md) — execution classes, contracts and evidence rule.
- [<code>docs/demo-video.md</code>](docs/demo-video.md) — real-product 45–60 second recording script.
- [<code>config/external-engines.json</code>](config/external-engines.json) — pinned upstream engines and boundaries.
- [<code>.env.example</code>](.env.example) — local/AWS/model/engine configuration names.
- [<code>docker-compose.external.yml</code>](docker-compose.external.yml) — optional local real-engine stack.

---

## Limitations / current status

- A11 and A12 remain blocked on real credentialed AWS execution evidence.
- Corrected Twenty/Cal.diy support is in open PR #7, not <code>main</code>.
- Local startup/routing improvements are in open PR #8, not <code>main</code>.
- Heavy local engines are intentionally optional; unavailable lanes should finish Incomplete.
- No real demo GIF/MP4 is committed until it is captured from an actual run.
- The repository currently has **no root license file**. Do not assume reuse rights beyond what GitHub and individual upstream dependencies explicitly grant.

---

## Evidence, not confidence theater

VERIFAI is useful only if a user can distinguish **what an agent believes**, **what a tool actually executed**, **what failed to run**, and **what was independently re-proven after a repair**.

That distinction is the product.
