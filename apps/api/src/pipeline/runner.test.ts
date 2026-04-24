import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDockerRunner } from './runner.js';
import type { StageLogger } from './logger.js';
import { DeployFailedError } from '../lib/errors.js';
import type { Deployment } from '@updraft/shared-types';

interface SpawnCall {
  cmd: string;
  args: readonly string[];
}

function scriptedSpawn(scripts: Array<{ stdout: string[]; stderr?: string[]; exitCode: number }>, calls: SpawnCall[]) {
  let i = 0;
  return ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const script = scripts[i] ?? { stdout: [], exitCode: 0 };
    i += 1;
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    child.stdout = Readable.from([script.stdout.map((l) => `${l}\n`).join('')]);
    child.stderr = Readable.from([(script.stderr ?? []).map((l) => `${l}\n`).join('')]);
    setImmediate(() => child.emit('close', script.exitCode));
    return child as never;
  });
}

function loggerStub(): StageLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async log(msg) {
      lines.push(msg);
    },
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
  it('removes a stale container then starts a new one with the expected args', async () => {
    const calls: SpawnCall[] = [];
    const runner = createDockerRunner({
      spawn: scriptedSpawn(
        [
          { stdout: [], exitCode: 1 },
          { stdout: ['abc1234567890def1234567890abcdef1234567890abcdef1234567890abcd'], exitCode: 0 },
          { stdout: ['{"Status":"running","Health":{"Status":"healthy"}}'], exitCode: 0 },
        ],
        calls,
      ),
      network: 'testnet',
      internalPort: 3000,
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 10,
    });
    const logger = loggerStub();
    const result = await runner.run({ deployment, imageTag: 'dep-abc:42', logger });

    expect(result.container_name).toBe('dep-abc');
    expect(result.internal_port).toBe(3000);
    expect(result.container_id).toMatch(/^[0-9a-f]{12,}$/i);

    expect(calls[0]?.args).toEqual(['rm', '-f', 'dep-abc']);
    expect(calls[1]?.args).toEqual([
      'run',
      '-d',
      '--name', 'dep-abc',
      '--network', 'testnet',
      '--env', 'PORT=3000',
      '--label', 'updraft.deployment=abc',
      '--label', 'updraft.port=3000',
      'dep-abc:42',
    ]);
    expect(calls[2]?.args).toEqual(['inspect', '--format', '{{json .State}}', 'dep-abc']);

    expect(logger.lines.some((l) => l.includes('Starting container dep-abc'))).toBe(true);
  });

  it('throws DeployFailedError when docker run exits non-zero', async () => {
    const calls: SpawnCall[] = [];
    const runner = createDockerRunner({
      spawn: scriptedSpawn(
        [
          { stdout: [], exitCode: 0 },
          { stdout: ['Error: no such image'], stderr: ['boom'], exitCode: 125 },
        ],
        calls,
      ),
      network: 'testnet',
    });
    await expect(
      runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(DeployFailedError);
  });

  it('throws DeployFailedError when docker run exits zero but prints no id', async () => {
    const calls: SpawnCall[] = [];
    const runner = createDockerRunner({
      spawn: scriptedSpawn(
        [
          { stdout: [], exitCode: 0 },
          { stdout: ['no id here'], exitCode: 0 },
        ],
        calls,
      ),
    });
    await expect(
      runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(DeployFailedError);
  });

  it('throws DeployFailedError when the container exits during health checks', async () => {
    const calls: SpawnCall[] = [];
    const runner = createDockerRunner({
      spawn: scriptedSpawn(
        [
          { stdout: [], exitCode: 0 },
          { stdout: ['abc1234567890def1234567890abcdef1234567890abcdef1234567890abcd'], exitCode: 0 },
          { stdout: ['{"Status":"exited"}'], exitCode: 0 },
        ],
        calls,
      ),
      healthCheckIntervalMs: 1,
      healthCheckTimeoutMs: 10,
    });

    await expect(
      runner.run({ deployment, imageTag: 'dep-abc:42', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(DeployFailedError);
  });
});
