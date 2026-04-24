import type { DeploymentRepository } from '../db/repository.js';

export interface PipelineQueue {
  enqueue(deploymentId: string): void;
  size(): number;
  drain(): Promise<void>;
  stop(): void;
}

export type RunFn = (deploymentId: string) => Promise<void>;

export interface QueueDeps {
  deployments: DeploymentRepository;
  pollIntervalMs?: number;
}

export function createPipelineQueue(
  deps: QueueDeps,
  run: RunFn,
): PipelineQueue {
  const pending: string[] = [];
  let current: Promise<void> | null = null;
  let stopped = false;
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;

  const tick = (): void => {
    if (current || stopped) return;
    const next = pending.shift();
    if (next === undefined) {
      const claimed = deps.deployments.claim();
      if (claimed) {
        current = run(claimed.id)
          .catch((err) => {
            console.error(`pipeline run failed for ${claimed.id}:`, err);
          })
          .finally(() => {
            current = null;
            tick();
          });
      } else {
        setTimeout(tick, pollIntervalMs);
      }
      return;
    }
    current = run(next)
      .catch((err) => {
        console.error(`pipeline run failed for ${next}:`, err);
      })
      .finally(() => {
        current = null;
        tick();
      });
  };

  return {
    enqueue(deploymentId) {
      pending.push(deploymentId);
      tick();
    },
    size() {
      return pending.length + (current ? 1 : 0);
    },
    async drain() {
      while (current || pending.length > 0) {
        if (current) await current;
      }
    },
    stop() {
      stopped = true;
    },
  };
}
