# AWS deployment handoff

The hackathon sandbox has an AWS-ready path using ECR + ECS Fargate + S3 + CloudWatch.

## Deploy

1. Build `services/sandbox/Dockerfile` and push it to Amazon ECR.
2. Deploy `infra/aws/cloudformation.yml` with `SandboxImage=<ECR image URI>`.
3. Run the resulting ECS task in private networking and expose the control API only to the VERIFIAI backend.
4. Store run artifacts in the encrypted S3 bucket returned by the stack.
5. Use CloudWatch logs as runtime evidence.

## Verified fallback

The same sandbox lifecycle and flagship experiment run locally without AWS credentials through:

```bash
npm run test:p0
npm run demo:e2e
docker compose -f docker-compose.demo.yml up --build
```

No secrets are committed. Applying the CloudFormation stack requires an authorized AWS account; the repository contains the deployment package, while the local fallback is the reproducible demo path.
