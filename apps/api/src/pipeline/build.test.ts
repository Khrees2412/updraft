import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRailpackBuilder } from './build.js';
import type { StageLogger } from './logger.js';
import { BuildFailedError } from '../lib/errors.js';
import type { Deployment } from '@updraft/shared-types';
import type { BuildCacheRepository } from '../db/repository.js';

function fakeSpawn(stdoutLines: string[], exitCode: number, captured?: { args?: readonly string[] }) {
  return ((_cmd: string, args: readonly string[]) => {
    if (captured) captured.args = args;
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    child.stdout = Readable.from([stdoutLines.map((l) => `${l}\n`).join('')]);
    child.stderr = Readable.from(['']);
    setImmediate(() => child.emit('close', exitCode));
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
  status: 'building',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

function stubCacheRepo(existing?: { cache_ref: string; hit_count: number }): BuildCacheRepository & { upserted: string[] } {
  const upserted: string[] = [];
  return {
    upserted,
    get: () => existing ? { id: 'x', source_key: 'k', last_used_at: '', ...existing } : null,
    upsert: (_key: string, ref: string) => { upserted.push(ref); return { id: 'x', source_key: 'k', cache_ref: ref, last_used_at: '', hit_count: 0 }; },
  };
}

describe('railpack builder', () => {
  it('produces a deterministic image tag and streams output', async () => {
    const captured: { args?: readonly string[] } = {};
    const builder = createRailpackBuilder({
      spawn: fakeSpawn(['Detected Node.js', 'Building...'], 0, captured),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
    });
    const logger = loggerStub();
    const wsPath = '/tmp/ws';
    const result = await builder.build({ deployment, workspacePath: wsPath, logger });
    const expectedTag = `dep-abc:${Math.floor(new Date('2026-04-24T00:00:00.000Z').getTime() / 1000)}`;
    expect(result.image_tag).toBe(expectedTag);
    expect(captured.args?.[0]).toBe('-c');
    expect(captured.args?.[1]).toContain('/root/.local/bin/railpack');
    expect(captured.args?.[1]).toContain('build');
    expect(captured.args?.[1]).toContain(wsPath);
    expect(captured.args?.[1]).toContain('--cache-key');
    expect(captured.args?.[1]).not.toContain('--cache-from');
    expect(captured.args?.[1]).not.toContain('--cache-to');
    expect(captured.args?.[1]).toContain('--progress=plain');
    expect(logger.lines).toContain('Detected Node.js');
    expect(logger.lines).toContain('Building...');
  });

  it('throws BuildFailedError on non-zero exit', async () => {
    const builder = createRailpackBuilder({
      spawn: fakeSpawn(['boom'], 1),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
    });
    await expect(
      builder.build({ deployment, workspacePath: '/tmp/ws', logger: loggerStub() }),
    ).rejects.toBeInstanceOf(BuildFailedError);
  });

  it('logs a cache MISS and calls upsert on first build for a source', async () => {
    const cache = stubCacheRepo();
    const logger = loggerStub();
    const captured: { args?: readonly string[] } = {};
    const builder = createRailpackBuilder({
      spawn: fakeSpawn([], 0, captured),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
      cacheRepo: cache,
    });
    await builder.build({ deployment, workspacePath: '/tmp/ws', logger });
    expect(logger.lines.some((l) => l.includes('[cache] MISS'))).toBe(true);
    expect(cache.upserted).toHaveLength(1);
    // must pass --cache-key (not --cache-from/--cache-to which don't exist in railpack)
    expect(captured.args?.[1]).toContain('--cache-key');
    expect(captured.args?.[1]).not.toContain('--cache-from');
    expect(captured.args?.[1]).not.toContain('--cache-to');
  });

  it('logs a cache HIT on second build for the same source', async () => {
    const cache = stubCacheRepo({ cache_ref: 'somekey', hit_count: 3 });
    const logger = loggerStub();
    const captured: { args?: readonly string[] } = {};
    const builder = createRailpackBuilder({
      spawn: fakeSpawn([], 0, captured),
      now: () => new Date('2026-04-24T00:00:00.000Z'),
      cacheRepo: cache,
    });
    await builder.build({ deployment, workspacePath: '/tmp/ws', logger });
    expect(logger.lines.some((l) => l.includes('[cache] HIT'))).toBe(true);
    expect(cache.upserted).toHaveLength(1);
    expect(captured.args?.[1]).toContain('--cache-key');
  });
});
