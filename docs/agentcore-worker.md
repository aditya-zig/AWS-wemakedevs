# AgentCore worker runtime

A04 uses Amazon Bedrock AgentCore Runtime as the isolation boundary for every real LLM worker.

- Each worker gets a unique `runtimeSessionId`.
- `InvokeAgentRuntime` receives the frozen `AgentWorkerLaunchBrief`.
- The worker container exposes AgentCore's required `POST /invocations` and `GET /ping` endpoints on port 8080.
- The runtime streams NDJSON status/evidence/report envelopes.
- The launcher converts timeout/crash into `Incomplete`, calls `StopRuntimeSession`, and the orchestrator also tears down completed sessions.
- Provider credentials are resolved inside the runtime from environment/AWS Secrets Manager; they never travel in the launch brief.

## Live acceptance check

After a real AgentCore runtime has been deployed and the caller has `bedrock-agentcore:InvokeAgentRuntime` and session-stop permissions:

```bash
VERIFIAI_AGENTCORE_RUNTIME_ARN='arn:aws:bedrock-agentcore:...' \
VERIFIAI_AGENTCORE_MODEL_PROFILE='openrouter:<model-id>' \
AWS_REGION='ap-south-1' \
npm run verify:agentcore
```

A04 is not considered fully accepted until this live smoke check succeeds against AWS. Unit tests only prove the mapping, failure handling and teardown protocol.
