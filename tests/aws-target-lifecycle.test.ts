import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AwsTargetLifecycle,
  AwsTargetLifecycleError,
  buildArbitraryRepoBuildspec,
  type AwsTargetLifecycleConfig,
  type AwsLikeClient,
} from '../services/bootstrap/aws-target-lifecycle.js';

const config: AwsTargetLifecycleConfig = {
  region: 'us-west-2',
  codeBuildProject: 'verifiai-target-build',
  ecrRepository: 'verifiai-targets',
  ecrRegistry: '123456789012.dkr.ecr.us-west-2.amazonaws.com',
  ecsCluster: 'verifiai',
  taskDefinition: 'verifiai-target-base',
  containerName: 'target',
  containerPort: 3000,
  subnetIds: ['subnet-private'],
  securityGroupIds: ['sg-target'],
  buildTimeoutMs: 1000,
  launchTimeoutMs: 1000,
  healthTimeoutMs: 1000,
};

const request = {
  repoUrl: 'https://github.com/example/real-app',
  branch: 'main',
  commitSha: 'deadbeef',
  imageTag: 'audit-deadbeef',
  healthPath: '/health',
};

test('A05 buildspec clones the exact public repo commit and pushes the requested ECR image', () => {
  const buildspec = buildArbitraryRepoBuildspec(request, config);
  assert.match(buildspec, /git clone --depth 1 --branch 'main' 'https:\/\/github\.com\/example\/real-app'/);
  assert.match(buildspec, /git checkout 'deadbeef'/);
  assert.match(buildspec, /VERIFIAI_UNSUPPORTED: Dockerfile not found/);
  assert.match(buildspec, /docker push '123456789012\.dkr\.ecr\.us-west-2\.amazonaws\.com\/verifiai-targets:audit-deadbeef'/);
});

test('A05 performs CodeBuild -> ECR -> ephemeral Fargate task -> health -> teardown', async () => {
  const codebuildCommands: string[] = [];
  const ecsCommands: string[] = [];
  const codebuild: AwsLikeClient = {
    async send(command: any) {
      codebuildCommands.push(command.constructor.name);
      if (command.constructor.name === 'StartBuildCommand') return { build: { id: 'build-1' } };
      if (command.constructor.name === 'BatchGetBuildsCommand') return { builds: [{ buildStatus: 'SUCCEEDED' }] };
      throw new Error(`unexpected CodeBuild command ${command.constructor.name}`);
    },
  };
  const ecr: AwsLikeClient = {
    async send(command: any) {
      assert.equal(command.constructor.name, 'DescribeImagesCommand');
      return { imageDetails: [{ imageDigest: 'sha256:123' }] };
    },
  };
  const ecs: AwsLikeClient = {
    async send(command: any) {
      ecsCommands.push(command.constructor.name);
      switch (command.constructor.name) {
        case 'DescribeTaskDefinitionCommand':
          return {
            taskDefinition: {
              family: 'verifiai-target-base',
              networkMode: 'awsvpc',
              cpu: '512',
              memory: '1024',
              requiresCompatibilities: ['FARGATE'],
              executionRoleArn: 'arn:execution',
              containerDefinitions: [{ name: 'target', image: 'old:image', essential: true, portMappings: [{ containerPort: 3000 }] }],
            },
          };
        case 'RegisterTaskDefinitionCommand':
          assert.equal(command.input.containerDefinitions[0].image, '123456789012.dkr.ecr.us-west-2.amazonaws.com/verifiai-targets:audit-deadbeef');
          return { taskDefinition: { taskDefinitionArn: 'arn:task-definition:ephemeral:1' } };
        case 'RunTaskCommand':
          assert.equal(command.input.taskDefinition, 'arn:task-definition:ephemeral:1');
          return { tasks: [{ taskArn: 'arn:task:1' }], failures: [] };
        case 'DescribeTasksCommand':
          return {
            tasks: [{
              taskArn: 'arn:task:1',
              lastStatus: 'RUNNING',
              attachments: [{ details: [{ name: 'privateIPv4Address', value: '10.0.1.25' }] }],
            }],
          };
        case 'StopTaskCommand':
        case 'DeregisterTaskDefinitionCommand':
          return {};
        default:
          throw new Error(`unexpected ECS command ${command.constructor.name}`);
      }
    },
  };

  const healthUrls: string[] = [];
  const lifecycle = new AwsTargetLifecycle(config, {
    codebuild,
    ecr,
    ecs,
    sleep: async () => {},
    fetchFn: (async (url: any) => {
      healthUrls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch,
    now: () => '2026-09-18T17:00:00.000Z',
  });

  const handle = await lifecycle.start(request);
  assert.equal(handle.buildId, 'build-1');
  assert.equal(handle.imageDigest, 'sha256:123');
  assert.equal(handle.taskArn, 'arn:task:1');
  assert.equal(handle.taskDefinitionArn, 'arn:task-definition:ephemeral:1');
  assert.equal(handle.targetUrl, 'http://10.0.1.25:3000');
  assert.deepEqual(healthUrls, ['http://10.0.1.25:3000/health']);
  await lifecycle.stop(handle);

  assert.deepEqual(codebuildCommands, ['StartBuildCommand', 'BatchGetBuildsCommand']);
  assert.ok(ecsCommands.includes('StopTaskCommand'));
  assert.ok(ecsCommands.includes('DeregisterTaskDefinitionCommand'));
});

test('A05 reports exact CodeBuild failure instead of fake success', async () => {
  const lifecycle = new AwsTargetLifecycle(config, {
    codebuild: {
      async send(command: any) {
        if (command.constructor.name === 'StartBuildCommand') return { build: { id: 'build-fail' } };
        return {
          builds: [{
            buildStatus: 'FAILED',
            phases: [{ contexts: [{ message: 'VERIFIAI_UNSUPPORTED: Dockerfile not found at Dockerfile' }] }],
          }],
        };
      },
    },
    ecr: { async send() { throw new Error('ECR must not be called'); } },
    ecs: { async send() { throw new Error('ECS must not be called'); } },
    sleep: async () => {},
  });

  await assert.rejects(
    () => lifecycle.start(request),
    (error: any) => {
      assert.ok(error instanceof AwsTargetLifecycleError);
      assert.equal(error.phase, 'build');
      assert.match(error.message, /FAILED/);
      assert.match(error.message, /Dockerfile not found/);
      return true;
    },
  );
});


test('A05 private target health can be verified through the VPC Lambda probe', async () => {
  const probeConfig = { ...config, healthProbeFunctionName: 'verifiai-private-health' };
  const lambdaCalls: any[] = [];
  const lifecycle = new AwsTargetLifecycle(probeConfig, {
    codebuild: {
      async send(command: any) {
        if (command.constructor.name === 'StartBuildCommand') return { build: { id: 'build-private' } };
        return { builds: [{ buildStatus: 'SUCCEEDED' }] };
      },
    },
    ecr: { async send() { return { imageDetails: [{ imageDigest: 'sha256:private' }] }; } },
    ecs: {
      async send(command: any) {
        switch (command.constructor.name) {
          case 'DescribeTaskDefinitionCommand':
            return { taskDefinition: {
              family: 'verifiai-target-base',
              networkMode: 'awsvpc',
              cpu: '512',
              memory: '1024',
              requiresCompatibilities: ['FARGATE'],
              executionRoleArn: 'arn:execution',
              containerDefinitions: [{ name: 'target', image: 'old:image', essential: true }],
            } };
          case 'RegisterTaskDefinitionCommand':
            return { taskDefinition: { taskDefinitionArn: 'arn:task-definition:private:1' } };
          case 'RunTaskCommand':
            return { tasks: [{ taskArn: 'arn:task:private' }], failures: [] };
          case 'DescribeTasksCommand':
            return { tasks: [{
              taskArn: 'arn:task:private',
              lastStatus: 'RUNNING',
              attachments: [{ details: [{ name: 'privateIPv4Address', value: '10.0.9.25' }] }],
            }] };
          default:
            return {};
        }
      },
    },
    lambda: {
      async send(command: any) {
        lambdaCalls.push(command.input);
        return {
          Payload: new TextEncoder().encode(JSON.stringify({ ok: true, statusCode: 200 })),
        };
      },
    },
    fetchFn: (async () => { throw new Error('direct fetch must not run for private probe'); }) as typeof fetch,
    sleep: async () => {},
  });

  const handle = await lifecycle.start(request);
  assert.equal(handle.healthUrl, 'http://10.0.9.25:3000/health');
  assert.equal(lambdaCalls.length, 1);
  assert.equal(lambdaCalls[0].FunctionName, 'verifiai-private-health');
  assert.match(new TextDecoder().decode(lambdaCalls[0].Payload), /10\.0\.9\.25:3000\/health/);
});
