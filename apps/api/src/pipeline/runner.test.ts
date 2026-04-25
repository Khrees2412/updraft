import { describe, expect, it } from 'vitest';
import { createDockerRunner } from './runner.js';
import { DeployFailedError } from '../lib/errors.js';
import type { Deployment } from '@updraft/shared-types';
import type Dockerode from 'dockerode';

// Minimal fake Dockerode that records calls and drives the state machine
function fakeDocker(opts: {
  networks?: string[];
  containerStates?: Array<{ Status: string; Health?: { Status: string } }>;
  startError?: Error;
  createError?: Error;
}): Dockerode {
  let inspectCallCount = 0;
  const states = opts.containerStates ?? [{ Status: 'running' }];

  return {
    listNetworks: async () =>
      (opts.networks ?? ['updraft_deployments']).map((Name) => ({ Name })),
    createNetwork: async () => ({}),
    getContainer: () => ({
      remove: async () => ({}),
    }),
    createContainer: async () => {
      if (opts.createError) throw opts.createError;
      return {
        start: async () => {
          if (opts.startError) throw opts.startError;
        },
        inspect: async () => {
          const state = states[inspectCallCount] ?? states[states.length - 1];
          inspectCallCount += 1;
          return { Id: 'abc1234567890def1234567890abcdef12345678', State: state };
        },
      };
    },
  } as unknown as Dockerode;
}

function loggerStub() {
  const lines: string[] = [];
  return {
    lines,
    async log(msg: string) { lines.push(msg); },
    async status() {},
  };
}

const deployment: Deployment = {
  id: 'abc',
  source_type: 'git',
  source_ref: 'https://example.com/r.git',
  status: 'deploying',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

describe('docker runner', () => {
  it('starts a container and returns id/name/port on healthy state', async () => {
    const runner = createDockerRunner({
      docker: fakeDocker({ containerStates: [{ Status: 'running' }] }),
      network: 'testnet',
      internalPort: 3000,
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 100,
    });
    const logger = loggerStub();
    const result = await runner.run({ deployment, imageTag: 'dep-abc:42', logger });

    expect(result.container_name).toBe('dep-abc');
    expect(result.internal_port).toBe(3000);
    expect(result.container_id).toMatch(/^[0-9a-f]{12,}$/i);
    expect(logger.lines.some((l) => l.includes('Starting container dep-abc'))).toBe(true);
    expect(logger.lines.some((l) => l.includes('is running'))).toBe(true);
  });

  it('creates the network if it does not exist', async () => {
    let networkCreated = false;
    const docker = fakeDocker({ networks: ['other_net'], containerStates: [{ Status: 'running' }] });
    (docker as unknown as { createNetwork: (o: unknown) => Promise<unknown> }).createNetwork = async () => {
      networkCreated = true;
      return {};
    };

    const runner = createDockerRunner({
      docker,
      network: 'new_network',
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 100,
    });
    await runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() });
    expect(networkCreated).toBe(true);
  });

  it('skips network creation when it already exists', async () => {
    let networkCreated = false;
    const docker = fakeDocker({ networks: ['testnet'], containerStates: [{ Status: 'running' }] });
    (docker as unknown as { createNetwork: (o: unknown) => Promise<unknown> }).createNetwork = async () => {
      networkCreated = true;
      return {};
    };

    const runner = createDockerRunner({
      docker,
      network: 'testnet',
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 100,
    });
    await runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() });
    expect(networkCreated).toBe(false);
  });

  it('throws DeployFailedError when container exits during health checks', async () => {
    const runner = createDockerRunner({
      docker: fakeDocker({ containerStates: [{ Status: 'exited' }] }),
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 100,
    });
    await expect(
      runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(DeployFailedError);
  });

  it('throws DeployFailedError on health check timeout', async () => {
    const runner = createDockerRunner({
      docker: fakeDocker({ containerStates: [{ Status: 'starting' }] }),
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 5,
    });
    await expect(
      runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(DeployFailedError);
  });

  it('waits through intermediate states before becoming running', async () => {
    const runner = createDockerRunner({
      docker: fakeDocker({
        containerStates: [
          { Status: 'created' },
          { Status: 'starting' },
          { Status: 'running' },
        ],
      }),
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 500,
    });
    const result = await runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() });
    expect(result.container_name).toBe('dep-abc');
  });
});
