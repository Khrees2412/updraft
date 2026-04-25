import Dockerode from 'dockerode';
import { DeployFailedError } from '../lib/errors.js';
import type { StageLogger } from './logger.js';
import type { Deployment } from '@updraft/shared-types';

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
  docker?: Dockerode;
  network?: string;
  internalPort?: number;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
}

async function ensureNetwork(docker: Dockerode, name: string): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (!networks.some((n) => n.Name === name)) {
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
  }
}

export function createDockerRunner(deps: DockerRunnerDeps = {}): Runner {
  const docker = deps.docker ?? new Dockerode();
  const network = deps.network ?? process.env['DEPLOYMENT_NETWORK'] ?? 'updraft_deployments';
  const internalPort = deps.internalPort ?? Number(process.env['APP_INTERNAL_PORT'] ?? 3000);
  const healthCheckIntervalMs = deps.healthCheckIntervalMs ?? 1000;
  const healthCheckTimeoutMs = deps.healthCheckTimeoutMs ?? 30000;

  return {
    async run({ deployment, imageTag, logger }) {
      const containerName = `dep-${deployment.id}`;

      await ensureNetwork(docker, network);

      // Remove any prior container with the same name
      try {
        const prior = docker.getContainer(containerName);
        await prior.remove({ force: true });
        await logger.log(`Removed prior container ${containerName}`);
      } catch (err: unknown) {
        // 404 means it didn't exist — that's fine
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
      }

      await logger.log(`Starting container ${containerName} from ${imageTag} on network ${network}`);

      const container = await docker.createContainer({
        name: containerName,
        Image: imageTag,
        Env: [`PORT=${internalPort}`],
        Labels: {
          'updraft.deployment': deployment.id,
          'updraft.port': String(internalPort),
        },
        HostConfig: {
          NetworkMode: network,
        },
      });

      await container.start();
      const info = await container.inspect();
      const container_id = info.Id;

      await logger.log(`Container started with ID ${container_id.slice(0, 12)}`);

      // Poll until running/healthy or terminal failure
      const deadline = Date.now() + healthCheckTimeoutMs;
      while (Date.now() <= deadline) {
        const state = (await container.inspect()).State;
        const status = state.Status ?? 'unknown';
        const health = (state as { Health?: { Status?: string } }).Health?.Status;

        if (status === 'running' && (!health || health === 'healthy')) {
          await logger.log(`Container ${containerName} is running`);
          return { container_id, container_name: containerName, internal_port: internalPort };
        }

        if (status === 'exited' || status === 'dead' || health === 'unhealthy') {
          throw new DeployFailedError(
            `Container failed health check (status=${status}, health=${health ?? 'none'})`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, healthCheckIntervalMs));
      }

      throw new DeployFailedError(
        `Container did not become healthy within ${healthCheckTimeoutMs}ms`,
      );
    },
  };
}
