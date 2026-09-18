# VERIFIAI Hackathon Release

Release state: integrated directly on `main`.

## Verified software path

- Core contracts, requirements planning, orchestrator, evidence/judge/repair loop
- Isolated sandbox lifecycle with cleanup, resource metadata and fault injection
- Common adapter runtime
- Cua-compatible desktop workflow evidence
- Scoped Strix-compatible security evidence
- Flagship payment-latency failure → diagnosis → repair → VERIFIED flow
- 16-stage responsive web product journey
- Demo UI now starts the executed flagship verification and renders returned evidence/result data instead of only advancing through static screens
- Two-clean-run release verifier
- AWS ECS Fargate + encrypted S3 + CloudWatch deployment package
- Hardened single-machine Docker fallback

## Commands

```bash
npm install
npm run check
npm run start:web
```

`npm run check` runs typecheck, existing core tests, P0 integration tests, P1 adapter tests and the two-clean-run flagship verifier.

`npm run start:web` serves the demo at `http://localhost:4173`. The **Start Verification** action executes the local flagship verification endpoint and feeds its result back into the UI.

## External capture/deployment

The codebase contains the AWS deployment package and local fallback. Applying AWS infrastructure requires account credentials. GitHub OAuth also requires the configured GitHub App credentials. Cua and Strix use deterministic compatible fallbacks in the default demo path unless their external runtimes are configured. The submission screen recording remains a human capture step using `npm run start:web` and `docs/demo-script.md`.
