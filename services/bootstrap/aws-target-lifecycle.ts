import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild';
import {
  DescribeImagesCommand,
  ECRClient,
} from '@aws-sdk/client-ecr';
import {
  InvokeCommand,
  LambdaClient,
} from '@aws-sdk/client-lambda';
import {
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';

export interface AwsLikeClient {
  send(command: unknown): Promise<any>;
}

export interface AwsTargetLifecycleConfig {
  region: string;
  codeBuildProject: string;
  ecrRepository: string;
  ecrRegistry: string;
  ecsCluster: string;
  taskDefinition: string;
  containerName: string;
  containerPort: number;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp?: boolean;
  buildTimeoutMs?: number;
  launchTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthProbeFunctionName?: string;
}

export interface AwsTargetSidecar {
  name: string;
  image: string;
  essential?: boolean;
  environment?: Record<string, string>;
}

export interface AwsTargetRequest {
  repoUrl: string;
  branch: string;
  commitSha: string;
  imageTag: string;
  dockerfile?: string;
  buildContext?: string;
  buildTarget?: string;
  buildArgs?: Record<string, string>;
  environment?: Record<string, string>;
  sidecars?: AwsTargetSidecar[];
  healthPath?: string;
}

export interface AwsTargetHandle {
  buildId: string;
  imageUri: string;
  imageDigest: string;
  taskArn: string;
  taskDefinitionArn: string;
  targetUrl: string;
  healthUrl: string;
  launchedAt: string;
}

export class AwsTargetLifecycleError extends Error {
  constructor(
    public readonly phase: 'build' | 'image' | 'launch' | 'health' | 'teardown',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AwsTargetLifecycleError';
  }
}

export interface AwsTargetLifecycleOptions {
  codebuild?: AwsLikeClient;
  ecr?: AwsLikeClient;
  ecs?: AwsLikeClient;
  lambda?: AwsLikeClient;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

function shell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function repoRelativePath(value: string | undefined, fallback: string, label: string): string {
  const normalized = (value?.trim() || fallback).replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\\')) {
    throw new AwsTargetLifecycleError('build', `VERIFIAI_UNSUPPORTED: invalid ${label} '${value ?? ''}'`);
  }
  return normalized;
}

function assertEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new AwsTargetLifecycleError('build', `VERIFIAI_UNSUPPORTED: invalid environment/build-arg name '${name}'`);
  }
}

function mergeEnvironment(
  existing: Array<{ name?: string; value?: string }> | undefined,
  overrides: Record<string, string> | undefined,
): Array<{ name: string; value: string }> | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return existing as Array<{ name: string; value: string }> | undefined;
  const merged = new Map<string, string>();
  for (const item of existing ?? []) {
    if (item?.name && typeof item.value === 'string') merged.set(item.name, item.value);
  }
  for (const [name, value] of Object.entries(overrides)) {
    assertEnvironmentName(name);
    merged.set(name, String(value));
  }
  return [...merged].map(([name, value]) => ({ name, value }));
}

export function buildArbitraryRepoBuildspec(request: AwsTargetRequest, config: AwsTargetLifecycleConfig): string {
  const dockerfile = repoRelativePath(request.dockerfile, 'Dockerfile', 'Dockerfile path');
  const buildContext = repoRelativePath(request.buildContext, '.', 'Docker build context');
  const imageUri = `${config.ecrRegistry}/${config.ecrRepository}:${request.imageTag}`;
  const dockerfilePath = `/tmp/verifiai-target/${dockerfile}`;
  const contextPath = buildContext === '.' ? '/tmp/verifiai-target' : `/tmp/verifiai-target/${buildContext}`;
  const buildArgs = Object.entries(request.buildArgs ?? {}).map(([name, value]) => {
    assertEnvironmentName(name);
    return `--build-arg ${shell(`${name}=${String(value)}`)}`;
  });
  const buildTarget = request.buildTarget?.trim();
  if (buildTarget && !/^[A-Za-z0-9_.-]+$/.test(buildTarget)) {
    throw new AwsTargetLifecycleError('build', `VERIFIAI_UNSUPPORTED: invalid Docker build target '${buildTarget}'`);
  }
  const dockerBuild = [
    'docker build',
    '-f', shell(dockerfilePath),
    ...(buildTarget ? ['--target', shell(buildTarget)] : []),
    ...buildArgs,
    '-t', shell(imageUri),
    shell(contextPath),
  ].join(' ');

  return [
    'version: 0.2',
    'phases:',
    '  pre_build:',
    '    commands:',
    `      - aws ecr get-login-password --region ${shell(config.region)} | docker login --username AWS --password-stdin ${shell(config.ecrRegistry)}`,
    '  build:',
    '    commands:',
    '      - rm -rf /tmp/verifiai-target && mkdir -p /tmp/verifiai-target',
    `      - git clone --depth 1 --branch ${shell(request.branch)} ${shell(request.repoUrl)} /tmp/verifiai-target`,
    `      - cd /tmp/verifiai-target && git fetch --depth 1 origin ${shell(request.commitSha)} && git checkout ${shell(request.commitSha)}`,
    `      - test -f ${shell(dockerfilePath)} || (echo "VERIFIAI_UNSUPPORTED: Dockerfile not found at ${dockerfile}" >&2; exit 42)`,
    ...(buildContext === '.' ? [] : [`      - test -d ${shell(contextPath)} || (echo "VERIFIAI_UNSUPPORTED: Docker build context not found at ${buildContext}" >&2; exit 42)`]),
    `      - ${dockerBuild}`,
    `      - docker push ${shell(imageUri)}`,
    'artifacts:',
    '  files: []',
  ].join('\n');
}

function buildStatus(output: any): string {
  return String(output?.builds?.[0]?.buildStatus ?? 'UNKNOWN');
}

function attachmentDetail(task: any, name: string): string | undefined {
  for (const attachment of task?.attachments ?? []) {
    for (const detail of attachment?.details ?? []) {
      if (detail?.name === name && typeof detail?.value === 'string') return detail.value;
    }
  }
  return undefined;
}

export class AwsTargetLifecycle {
  private readonly codebuild: AwsLikeClient;
  private readonly ecr: AwsLikeClient;
  private readonly ecs: AwsLikeClient;
  private readonly lambda: AwsLikeClient;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(private readonly config: AwsTargetLifecycleConfig, options: AwsTargetLifecycleOptions = {}) {
    this.codebuild = options.codebuild ?? new CodeBuildClient({ region: config.region });
    this.ecr = options.ecr ?? new ECRClient({ region: config.region });
    this.ecs = options.ecs ?? new ECSClient({ region: config.region });
    this.lambda = options.lambda ?? new LambdaClient({ region: config.region });
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(request: AwsTargetRequest): Promise<AwsTargetHandle> {
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(request.repoUrl)) {
      throw new AwsTargetLifecycleError('build', 'Only public GitHub repository URLs are supported by this A05 build path');
    }
    const imageUri = `${this.config.ecrRegistry}/${this.config.ecrRepository}:${request.imageTag}`;
    const buildspec = buildArbitraryRepoBuildspec(request, this.config);

    const started = await this.codebuild.send(new StartBuildCommand({
      projectName: this.config.codeBuildProject,
      sourceTypeOverride: 'NO_SOURCE',
      buildspecOverride: buildspec,
      environmentVariablesOverride: [
        { name: 'VERIFIAI_TARGET_REPO', value: request.repoUrl, type: 'PLAINTEXT' },
        { name: 'VERIFIAI_TARGET_COMMIT', value: request.commitSha, type: 'PLAINTEXT' },
        { name: 'VERIFIAI_TARGET_IMAGE', value: imageUri, type: 'PLAINTEXT' },
      ],
    }));
    const buildId = started?.build?.id;
    if (!buildId) throw new AwsTargetLifecycleError('build', 'CodeBuild did not return a build id');

    const buildDeadline = Date.now() + (this.config.buildTimeoutMs ?? 15 * 60_000);
    while (true) {
      const output = await this.codebuild.send(new BatchGetBuildsCommand({ ids: [buildId] }));
      const status = buildStatus(output);
      if (status === 'SUCCEEDED') break;
      if (['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(status)) {
        const phases = output?.builds?.[0]?.phases ?? [];
        const detail = phases.flatMap((phase: any) => phase?.contexts ?? []).map((context: any) => context?.message).filter(Boolean).join('; ');
        throw new AwsTargetLifecycleError('build', `CodeBuild ended with ${status}${detail ? `: ${detail}` : ''}`, output?.builds?.[0]);
      }
      if (Date.now() >= buildDeadline) throw new AwsTargetLifecycleError('build', 'CodeBuild exceeded the configured build timeout');
      await this.sleep(2_000);
    }

    const image = await this.ecr.send(new DescribeImagesCommand({
      repositoryName: this.config.ecrRepository,
      imageIds: [{ imageTag: request.imageTag }],
    }));
    const imageDigest = image?.imageDetails?.[0]?.imageDigest;
    if (!imageDigest) throw new AwsTargetLifecycleError('image', 'ECR image was not found after a successful CodeBuild');

    const activeTargets = await this.ecs.send(new ListTasksCommand({
      cluster: this.config.ecsCluster,
      startedBy: 'verifiai',
      maxResults: 1,
    }));
    if ((activeTargets?.taskArns ?? []).length > 0) {
      throw new AwsTargetLifecycleError('launch', 'Fargate concurrency guard blocked launch: max 1 VERIFAI managed target task');
    }

    const base = await this.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: this.config.taskDefinition }));
    const baseTask = base?.taskDefinition;
    if (!baseTask) throw new AwsTargetLifecycleError('launch', 'Base ECS task definition could not be loaded');
    const baseContainers = baseTask.containerDefinitions ?? [];
    const targetBase = baseContainers.find((container: any) => container.name === this.config.containerName);
    if (!targetBase) {
      throw new AwsTargetLifecycleError('launch', `Container ${this.config.containerName} was not found in the base task definition`);
    }

    const sidecarNames = new Set<string>();
    const sidecars = (request.sidecars ?? []).map((sidecar) => {
      if (!/^[A-Za-z0-9_-]{1,255}$/.test(sidecar.name)) {
        throw new AwsTargetLifecycleError('launch', `VERIFIAI_UNSUPPORTED: invalid sidecar name '${sidecar.name}'`);
      }
      if (sidecar.name === this.config.containerName || sidecarNames.has(sidecar.name)) {
        throw new AwsTargetLifecycleError('launch', `VERIFIAI_UNSUPPORTED: duplicate sidecar name '${sidecar.name}'`);
      }
      if (!sidecar.image?.trim()) {
        throw new AwsTargetLifecycleError('launch', `VERIFIAI_UNSUPPORTED: sidecar '${sidecar.name}' has no image`);
      }
      sidecarNames.add(sidecar.name);
      const logConfiguration = targetBase.logConfiguration
        ? {
            ...targetBase.logConfiguration,
            options: {
              ...(targetBase.logConfiguration.options ?? {}),
              'awslogs-stream-prefix': `sidecar-${sidecar.name}`,
            },
          }
        : undefined;
      return {
        name: sidecar.name,
        image: sidecar.image,
        essential: sidecar.essential ?? true,
        environment: mergeEnvironment(undefined, sidecar.environment),
        ...(logConfiguration ? { logConfiguration } : {}),
      };
    });

    const containers = baseContainers.map((container: any) =>
      container.name === this.config.containerName
        ? {
            ...container,
            image: imageUri,
            environment: mergeEnvironment(container.environment, request.environment),
            portMappings: [{
              containerPort: this.config.containerPort,
              hostPort: this.config.containerPort,
              protocol: 'tcp',
            }],
          }
        : container
    );
    containers.push(...sidecars);
    const registered = await this.ecs.send(new RegisterTaskDefinitionCommand({
      family: baseTask.family ?? 'verifiai-target',
      taskRoleArn: baseTask.taskRoleArn,
      executionRoleArn: baseTask.executionRoleArn,
      networkMode: baseTask.networkMode,
      containerDefinitions: containers,
      volumes: baseTask.volumes,
      placementConstraints: baseTask.placementConstraints,
      requiresCompatibilities: baseTask.requiresCompatibilities,
      cpu: baseTask.cpu,
      memory: baseTask.memory,
      runtimePlatform: baseTask.runtimePlatform,
      ephemeralStorage: baseTask.ephemeralStorage,
      proxyConfiguration: baseTask.proxyConfiguration,
    }));
    const taskDefinitionArn = registered?.taskDefinition?.taskDefinitionArn;
    if (!taskDefinitionArn) throw new AwsTargetLifecycleError('launch', 'ECS did not return the ephemeral target task definition ARN');

    const launched = await this.ecs.send(new RunTaskCommand({
      cluster: this.config.ecsCluster,
      taskDefinition: taskDefinitionArn,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.config.subnetIds,
          securityGroups: this.config.securityGroupIds,
          assignPublicIp: this.config.assignPublicIp ? 'ENABLED' : 'DISABLED',
        },
      },
      startedBy: 'verifiai',
      tags: [{ key: 'verifiai:managed', value: 'true' }],
      enableECSManagedTags: true,
    }));
    const taskArn = launched?.tasks?.[0]?.taskArn;
    const failure = launched?.failures?.[0];
    if (!taskArn) {
      try { await this.deregisterTaskDefinition(taskDefinitionArn); } catch {}
      throw new AwsTargetLifecycleError('launch', `ECS RunTask failed${failure?.reason ? `: ${failure.reason}` : ''}`, failure);
    }

    try {
      const launchDeadline = Date.now() + (this.config.launchTimeoutMs ?? 5 * 60_000);
      let task: any;
      while (true) {
        const described = await this.ecs.send(new DescribeTasksCommand({ cluster: this.config.ecsCluster, tasks: [taskArn] }));
        task = described?.tasks?.[0];
        const lastStatus = String(task?.lastStatus ?? 'UNKNOWN');
        if (lastStatus === 'RUNNING') break;
        if (lastStatus === 'STOPPED') {
          throw new AwsTargetLifecycleError('launch', `Fargate task stopped before becoming healthy: ${task?.stoppedReason ?? 'unknown reason'}`, task);
        }
        if (Date.now() >= launchDeadline) throw new AwsTargetLifecycleError('launch', 'Fargate target exceeded the configured launch timeout');
        await this.sleep(2_000);
      }

      const address = attachmentDetail(task, 'privateIPv4Address');
      if (!address) throw new AwsTargetLifecycleError('launch', 'Fargate task has no discoverable private IPv4 address');
      const targetUrl = `http://${address}:${this.config.containerPort}`;
      const healthUrl = new URL(request.healthPath ?? '/health', targetUrl).toString();
      const healthDeadline = Date.now() + (this.config.healthTimeoutMs ?? 60_000);
      let lastHealth = 'not attempted';
      while (Date.now() < healthDeadline) {
        try {
          const healthy = await this.probeHealth(healthUrl);
          lastHealth = healthy.message;
          if (healthy.ok) {
            return {
              buildId,
              imageUri,
              imageDigest,
              taskArn,
              taskDefinitionArn,
              targetUrl,
              healthUrl,
              launchedAt: this.now(),
            };
          }
        } catch (error: any) {
          lastHealth = String(error?.message ?? error);
        }
        await this.sleep(2_000);
      }
      throw new AwsTargetLifecycleError('health', `Fargate target did not pass health check: ${lastHealth}`);
    } catch (error) {
      try { await this.stopTask(taskArn, 'A05 startup failure cleanup'); } catch {}
      try { await this.deregisterTaskDefinition(taskDefinitionArn); } catch {}
      throw error;
    }
  }

  private async probeHealth(healthUrl: string): Promise<{ ok: boolean; message: string }> {
    if (this.config.healthProbeFunctionName) {
      const output = await this.lambda.send(new InvokeCommand({
        FunctionName: this.config.healthProbeFunctionName,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(JSON.stringify({ url: healthUrl })),
      }));
      if (output?.FunctionError) return { ok: false, message: `Lambda ${output.FunctionError}` };
      const raw = output?.Payload ? new TextDecoder().decode(output.Payload) : '';
      const body = raw ? JSON.parse(raw) : {};
      const status = Number(body?.statusCode ?? 0);
      return {
        ok: body?.ok === true && status >= 200 && status < 400,
        message: `VPC health probe HTTP ${status || 'unknown'}`,
      };
    }
    const response = await this.fetchFn(healthUrl, { signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, message: `HTTP ${response.status}` };
  }

  async stop(handle: Pick<AwsTargetHandle, 'taskArn' | 'taskDefinitionArn'>): Promise<void> {
    let failure: unknown;
    try { await this.stopTask(handle.taskArn, 'VERIFIAI audit target teardown'); } catch (error) { failure = error; }
    try { await this.deregisterTaskDefinition(handle.taskDefinitionArn); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }

  private async deregisterTaskDefinition(taskDefinitionArn: string): Promise<void> {
    try {
      await this.ecs.send(new DeregisterTaskDefinitionCommand({ taskDefinition: taskDefinitionArn }));
    } catch (error: any) {
      throw new AwsTargetLifecycleError('teardown', `Failed to deregister target task definition: ${String(error?.message ?? error)}`);
    }
  }

  private async stopTask(taskArn: string, reason: string): Promise<void> {
    try {
      await this.ecs.send(new StopTaskCommand({
        cluster: this.config.ecsCluster,
        task: taskArn,
        reason,
      }));
    } catch (error: any) {
      throw new AwsTargetLifecycleError('teardown', `Failed to stop Fargate target: ${String(error?.message ?? error)}`);
    }
  }
}
