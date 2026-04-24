import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runStreaming } from './process.js';

function fakeChild(stdoutChunks: string[], stderrChunks: string[], exitCode: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  child.stdout = Readable.from(stdoutChunks);
  child.stderr = Readable.from(stderrChunks);
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

describe('runStreaming', () => {
  it('splits stdout and stderr into lines and reports exit code', async () => {
    const lines: Array<{ line: string; source: string }> = [];
    const result = await runStreaming(
      'fake',
      ['arg'],
      (line, source) => {
        lines.push({ line, source });
      },
      {
        spawn: () => fakeChild(['hello\nworld\n'], ['oops\n'], 0) as never,
      },
    );
    expect(result.exitCode).toBe(0);
    const stdout = lines.filter((l) => l.source === 'stdout').map((l) => l.line);
    const stderr = lines.filter((l) => l.source === 'stderr').map((l) => l.line);
    expect(stdout).toEqual(['hello', 'world']);
    expect(stderr).toEqual(['oops']);
  });

  it('awaits async onLine handlers before resolving', async () => {
    const seen: number[] = [];
    let resolveLast!: () => void;
    const lastDone = new Promise<void>((r) => {
      resolveLast = r;
    });

    const promise = runStreaming(
      'fake',
      [],
      async (line) => {
        if (line === 'b') {
          await lastDone;
        }
        seen.push(line === 'a' ? 1 : 2);
      },
      { spawn: () => fakeChild(['a\nb\n'], [], 0) as never },
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toContain(1);
    resolveLast();
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([1, 2]);
  });

  it('propagates non-zero exit codes', async () => {
    const result = await runStreaming(
      'fake',
      [],
      () => {},
      { spawn: () => fakeChild([''], [''], 7) as never },
    );
    expect(result.exitCode).toBe(7);
  });
});
