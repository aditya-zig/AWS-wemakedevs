import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AwsTargetLifecycle } from '../dist/services/bootstrap/aws-target-lifecycle.js';
import { LiveAuditService } from '../dist/apps/api/swarms/service.js';
import { assessRealRepoAcceptance } from '../dist/services/release/real-repo-acceptance.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csv(name) {
  return required(name).split(',').map((value) => value.trim()).filter(Boolean);
}

function validateCandidate(candidate) {
  const requiredStrings = ['id', 'fullName', 'branch', 'dockerfile', 'healthPath', 'objective'];
  for (const name of requiredStrings) {
    if (typeof candidate?.[name] !== 'string' || !candidate[name].trim()) {
      throw new Error(`INCOMPLETE_BOOTSTRAP: repository contract is missing ${name}`);
    }
  }
  if (!Number.isInteger(candidate.containerPort) || candidate.containerPort < 1 || candidate.containerPort > 65535) {
    throw new Error('INCOMPLETE_BOOTSTRAP: repository contract has no valid containerPort');
  }
  if (!candidate.healthPath.startsWith('/')) {
    throw new Error('INCOMPLETE_BOOTSTRAP: healthPath must be an absolute HTTP path');
  }
  if (candidate.sidecars && !Array.isArray(candidate.sidecars)) {
    throw new Error('INCOMPLETE_BOOTSTRAP: sidecars must be an array');
  }
}

function materializeRuntimeEnvironment(candidate) {
  const environment = { ...(candidate.runtimeEnvironment ?? {}) };
  for (const name of candidate.generateSecrets ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`INCOMPLETE_BOOTSTRAP: invalid generated secret name ${name}`);
    }
    const bytes = name === 'CALENDSO_ENCRYPTION_KEY' ? 24 : 32;
    environment[name] = randomBytes(bytes).toString('base64');
  }
  return environment;
}

function incompleteDetail(error) {
  return {
    phase: typeof error?.phase === 'string' ? error.phase : 'audit',
    reason: String(error?.message || error),
    truthfulState: 'Incomplete',
  };
}

async function resolveCommit(fullName, branch) {
  const response = await fetch(`https://api.github.com/repos/${fullName}/commits/${encodeURIComponent(branch)}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'verifiai-real-repo-e2e',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub commit resolution failed for ${fullName}#${branch}: HTTP ${response.status}`);
  const body = await response.json();
  if (!body?.sha) throw new Error(`GitHub did not return a commit SHA for ${fullName}#${branch}`);
  return body.sha;
}

async function main() {
  const candidates = JSON.parse(await readFile(new URL('../config/e2e-repositories.json', import.meta.url), 'utf8'));
  const requested = process.argv[2] || process.env.VERIFIAI_E2E_REPO || 'twenty';
  const candidate = candidates.find((item) => item.id === requested);
  if (!candidate) throw new Error(`Unknown E2E repository '${requested}'. Valid: ${candidates.map((item) => item.id).join(', ')}`);
  validateCandidate(candidate);
  const runtimeEnvironment = materializeRuntimeEnvironment(candidate);

  for (const name of [
    'VERIFIAI_CODEBUILD_PROJECT',
    'VERIFIAI_ECR_REPOSITORY',
    'VERIFIAI_ECR_REGISTRY',
    'VERIFIAI_ECS_CLUSTER',
    'VERIFIAI_TARGET_TASK_DEFINITION',
    'VERIFIAI_TARGET_CONTAINER_NAME',
    'VERIFIAI_TARGET_SUBNET_IDS',
    'VERIFIAI_TARGET_SECURITY_GROUP_IDS',
    'VERIFIAI_HEALTH_PROBE_FUNCTION',
    'VERIFIAI_AGENTCORE_RUNTIME_ARN',
    'VERIFIAI_MODEL_PROVIDER',
    'VERIFIAI_MODEL_ID',
  ]) required(name);

  const commitSha = await resolveCommit(candidate.fullName, candidate.branch);
  const auditTag = `e2e-${candidate.id}-${commitSha.slice(0, 10)}-${Date.now()}`;
  const lifecycle = new AwsTargetLifecycle({
    region: process.env.AWS_REGION || 'ap-south-1',
    codeBuildProject: required('VERIFIAI_CODEBUILD_PROJECT'),
    ecrRepository: required('VERIFIAI_ECR_REPOSITORY'),
    ecrRegistry: required('VERIFIAI_ECR_REGISTRY'),
    ecsCluster: required('VERIFIAI_ECS_CLUSTER'),
    taskDefinition: required('VERIFIAI_TARGET_TASK_DEFINITION'),
    containerName: required('VERIFIAI_TARGET_CONTAINER_NAME'),
    containerPort: candidate.containerPort,
    subnetIds: csv('VERIFIAI_TARGET_SUBNET_IDS'),
    securityGroupIds: csv('VERIFIAI_TARGET_SECURITY_GROUP_IDS'),
    assignPublicIp: process.env.VERIFIAI_TARGET_ASSIGN_PUBLIC_IP === 'true',
    buildTimeoutMs: Number(process.env.VERIFIAI_BUILD_TIMEOUT_MS || 15 * 60_000),
    launchTimeoutMs: Number(process.env.VERIFIAI_LAUNCH_TIMEOUT_MS || 5 * 60_000),
    healthTimeoutMs: Number(process.env.VERIFIAI_HEALTH_TIMEOUT_MS || 90_000),
    healthProbeFunctionName: required('VERIFIAI_HEALTH_PROBE_FUNCTION'),
  });

  let target;
  const record = {
    candidate,
    commitSha,
    startedAt: new Date().toISOString(),
    architecture: 'Strands -> AgentCore workers -> CodeBuild/ECR/Fargate target',
    status: 'Running',
    bootstrap: {
      source: 'explicit-upstream-inspected-contract',
      dockerfile: candidate.dockerfile,
      buildContext: candidate.buildContext ?? '.',
      buildTarget: candidate.buildTarget ?? null,
      containerPort: candidate.containerPort,
      healthPath: candidate.healthPath,
      sidecars: (candidate.sidecars ?? []).map(({ name, image }) => ({ name, image })),
    },
    target: null,
    audit: null,
    acceptance: null,
    incomplete: null,
    cleanup: { required: false, attempted: false, succeeded: true },
  };

  try {
    target = await lifecycle.start({
      repoUrl: `https://github.com/${candidate.fullName}`,
      branch: candidate.branch,
      commitSha,
      imageTag: auditTag,
      dockerfile: candidate.dockerfile,
      buildContext: candidate.buildContext,
      buildTarget: candidate.buildTarget,
      buildArgs: candidate.buildArgs,
      environment: runtimeEnvironment,
      sidecars: candidate.sidecars,
      healthPath: candidate.healthPath,
    });
    record.cleanup = { required: true, attempted: false, succeeded: false };
    record.target = target;
    if (process.env.GITHUB_ENV) {
      await appendFile(process.env.GITHUB_ENV, `VERIFIAI_E2E_TASK_ARN=${target.taskArn}\nVERIFIAI_E2E_TASK_DEFINITION_ARN=${target.taskDefinitionArn}\n`);
    }

    const service = new LiveAuditService({
      env: {
        ...process.env,
        VERIFIAI_EXECUTION_MODE: 'agentcore',
        VERIFIAI_MAX_CONCURRENT_WORKERS: process.env.VERIFIAI_MAX_CONCURRENT_WORKERS || '4',
        VERIFIAI_HARD_RUN_SPEND_USD: process.env.VERIFIAI_HARD_RUN_SPEND_USD || '2.5',
      },
    });
    const started = await service.start({
      repository: {
        provider: 'github',
        fullName: candidate.fullName,
        url: `https://github.com/${candidate.fullName}`,
        branch: candidate.branch,
        commitSha,
      },
      target: {
        id: target.taskArn,
        url: target.targetUrl,
        environment: 'shared-observation',
        immutable: true,
      },
      objective: candidate.objective,
    });

    const configuredTtlMs = Math.min(Number(process.env.VERIFIAI_E2E_TIMEOUT_MS || 20 * 60_000), 20 * 60_000);
    const deadline = new Date(target.launchedAt).getTime() + configuredTtlMs;
    let current = started;
    while (!current.state.finished && !current.error) {
      if (Date.now() >= deadline) {
        await service.stop(started.auditId).catch(() => {});
        throw new Error('Real-repo audit exceeded VERIFIAI_E2E_TIMEOUT_MS');
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
      current = service.get(started.auditId);
      if (!current) throw new Error('Live audit disappeared from in-memory run service');
    }
    if (current.error) throw new Error(current.error);
    record.audit = current;

    if (!current.result) {
      throw new Error('Real-repo audit did not return a final result');
    }
    record.acceptance = assessRealRepoAcceptance(current.result);
    if (!record.acceptance.ok) {
      throw new Error(`Real-repo Deep Audit acceptance failed: ${record.acceptance.failures.join('; ')}`);
    }
    record.status = 'Completed';
  } catch (error) {
    record.status = 'Incomplete';
    record.incomplete = incompleteDetail(error);
    throw error;
  } finally {
    if (target) {
      record.cleanup.attempted = true;
      try {
        await lifecycle.stop(target);
        record.cleanup.succeeded = true;
      } catch (error) {
        record.cleanup.error = String(error?.message || error);
      }
    }
    record.finishedAt = new Date().toISOString();
    const outDir = resolve(process.env.VERIFIAI_E2E_OUTPUT_DIR || 'artifacts/real-repo-e2e');
    await mkdir(outDir, { recursive: true });
    const outPath = resolve(outDir, `${candidate.id}-${Date.now()}.json`);
    await writeFile(outPath, JSON.stringify(record, null, 2));
    console.log(`VERIFIAI_E2E_ARTIFACT=${outPath}`);
    console.log(JSON.stringify({
      repository: candidate.fullName,
      commitSha,
      target: target ? { imageDigest: target.imageDigest, taskArn: target.taskArn, healthUrl: target.healthUrl } : null,
      outcome: record.audit?.result?.outcome || null,
      evidence: record.audit?.state?.evidence?.length || 0,
      workers: record.audit?.state?.plan?.tasks?.length || 0,
      spend: record.audit?.state?.guardrails?.estimatedSpendUsd || 0,
      acceptance: record.acceptance,
      cleanup: record.cleanup,
    }, null, 2));
  }

  if (record.cleanup.required && !record.cleanup.succeeded) throw new Error('Fargate target cleanup did not complete');
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
