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
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
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
}

export interface AwsTargetRequest {
  repoUrl: string;
  branch: string;
  commitSha: string;
  imageTag: string;
  dockerfile?: string;
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
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => string;
}

function shell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildArbitraryRepoBuildspec(request: AwsTargetRequest, config: AwsTargetLifecycleConfig): string {
  const dockerfile = request.dockerfile?.trim() || 'Dockerfile';
  const imageUri = `${config.ecrRegistry}/${config.ecrRepository}:${request.imageTag}`;
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
    `      - test -f /tmp/verifiai-target/${dockerfile} || (echo "VERIFIAI_UNSUPPORTED: Dockerfile not found at ${dockerfile}" >&2; exit 42)`,
    `      - docker build -f /tmp/verifiai-target/${dockerfile} -t ${shell(imageUri)} /tmp/verifiai-target`,
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
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;

  constructor(private readonly config: AwsTargetLifecycleConfig, options: AwsTargetLifecycleOptions = {}) {
    this.codebuild = options.codebuild ?? new CodeBuildClient({ region: config.region });
    this.ecr = options.ecr ?? new ECRClient({ region: config.region });
    this.ecs = options.ecs ?? new ECSClient({ region: config.region });
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

    const base = await this.ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: this.config.taskDefinition }));
    const baseTask = base?.taskDefinition;
    if (!baseTask) throw new AwsTargetLifecycleError('launch', 'Base ECS task definition could not be loaded');
    const containers = (baseTask.containerDefinitions ?? []).map((container: any) =>
      container.name === this.config.containerName ? { ...container, image: imageUri } : container
    );
    if (!containers.some((container: any) => container.name === this.config.containerName && container.image === imageUri)) {
      throw new AwsTargetLifecycleError('launch', `Container ${this.config.containerName} was not found in the base task definition`);
    }
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
          const response = await this.fetchFn(healthUrl, { signal: AbortSignal.timeout(5_000) });
          lastHealth = `HTTP ${response.status}`;
          if (response.ok) {
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
