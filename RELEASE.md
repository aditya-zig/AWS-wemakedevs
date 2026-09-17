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
- Two-clean-run release verifier
- AWS ECS Fargate + encrypted S3 + CloudWatch deployment package
- Hardened single-machine Docker fallback

## Commands

```bash
npm install
npm run check
npm run start:web
```

`npm run check` runs typecheck, existing core tests, P0 integration tests and the two-clean-run flagship verifier.

## External capture/deployment

The codebase contains the AWS deployment package and local fallback. Applying AWS infrastructure requires account credentials. The submission screen recording is a human capture step using `npm run start:web` and `docs/demo-script.md`.
