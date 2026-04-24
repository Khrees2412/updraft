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
}

export function createDockerRunner(deps: DockerRunnerDeps = {}): Runner {
  const command = deps.command ?? 'docker';
  const network = deps.network ?? process.env['DEPLOYMENT_NETWORK'] ?? 'updraft_deployments';
  const internalPort = deps.internalPort ?? Number(process.env['APP_INTERNAL_PORT'] ?? 3000);

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

      return { container_id, container_name: containerName, internal_port: internalPort };
    },
  };
}
