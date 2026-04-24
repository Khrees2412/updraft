import type { Deployment } from '@updraft/shared-types';
import { runStreaming, type SpawnOptions } from './process.js';
import { DeployFailedError } from '../lib/errors.js';
import type { StageLogger } from './logger.js';

export interface RunInput {
  deployment: Deployment;
  imageTag: string;
  logger: StageLogger;
}

export interface RunResult {
  container_id: string;
  container_name: string;
  internal_port: number;
}

export interface Runner {
  run(input: RunInput): Promise<RunResult>;
}

export interface DockerRunnerDeps {
  spawn?: SpawnOptions['spawn'];
  network?: string;
  internalPort?: number;
  command?: string;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
}

export function createDockerRunner(deps: DockerRunnerDeps = {}): Runner {
  const command = deps.command ?? 'docker';
  const network = deps.network ?? process.env['DEPLOYMENT_NETWORK'] ?? 'updraft_deployments';
  const internalPort = deps.internalPort ?? Number(process.env['APP_INTERNAL_PORT'] ?? 3000);
  const healthCheckIntervalMs = deps.healthCheckIntervalMs ?? 1000;
  const healthCheckTimeoutMs = deps.healthCheckTimeoutMs ?? 30000;

  return {
    async run({ deployment, imageTag, logger }) {
      const containerName = `dep-${deployment.id}`;

      await logger.log(`Removing any prior container named ${containerName}`);
      await runStreaming(
        command,
        ['rm', '-f', containerName],
        async () => {},
        deps.spawn ? { spawn: deps.spawn } : {},
      );

      await logger.log(`Starting container ${containerName} from ${imageTag} on network ${network}`);
      const lines: string[] = [];
      const result = await runStreaming(
        command,
        [
          'run',
          '-d',
          '--name', containerName,
          '--network', network,
          '--env', `PORT=${internalPort}`,
          '--label', `updraft.deployment=${deployment.id}`,
          '--label', `updraft.port=${internalPort}`,
          imageTag,
        ],
        async (line) => {
          lines.push(line);
          await logger.log(line);
        },
        deps.spawn ? { spawn: deps.spawn } : {},
      );

      if (result.exitCode !== 0) {
        throw new DeployFailedError(`docker run exited with code ${result.exitCode}`);
      }

      const container_id = lines.reverse().find((l) => /^[0-9a-f]{12,}$/i.test(l.trim()))?.trim();
      if (!container_id) {
        throw new DeployFailedError('docker run did not return a container id');
      }

      await logger.log(`Waiting for container ${containerName} to report running/healthy`);
      const deadline = Date.now() + healthCheckTimeoutMs;

      while (Date.now() <= deadline) {
        const inspectLines: string[] = [];
        const inspect = await runStreaming(
          command,
          ['inspect', '--format', '{{json .State}}', containerName],
          async (line) => {
            inspectLines.push(line);
            await logger.log(line);
          },
          deps.spawn ? { spawn: deps.spawn } : {},
        );

        if (inspect.exitCode !== 0) {
          throw new DeployFailedError(`docker inspect exited with code ${inspect.exitCode}`);
        }

        const rawState = inspectLines.find((line) => line.trim().startsWith('{'));
        if (!rawState) {
          throw new DeployFailedError('docker inspect did not return container state');
        }

        const state = JSON.parse(rawState) as {
          Status?: string;
          Health?: { Status?: string };
        };
        const status = state.Status ?? 'unknown';
        const health = state.Health?.Status;

        if (status === 'running' && (!health || health === 'healthy')) {
          return { container_id, container_name: containerName, internal_port: internalPort };
        }

        if (status === 'exited' || status === 'dead' || health === 'unhealthy') {
          throw new DeployFailedError(`container failed health check (status=${status}, health=${health ?? 'none'})`);
        }

        await new Promise((resolve) => setTimeout(resolve, healthCheckIntervalMs));
      }

      throw new DeployFailedError(`container did not become healthy within ${healthCheckTimeoutMs}ms`);
    },
  };
}
