import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import {
  createDeploymentRepository,
  createLogRepository,
  DeploymentNotFoundError,
  InvalidStatusTransitionError,
  isValidStatusTransition,
} from './repository.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('deployment repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates a deployment in pending state', () => {
    const repo = createDeploymentRepository(db);
    const created = repo.create({ sourceType: 'git', sourceRef: 'https://example.com/repo.git' });
    expect(created.status).toBe('pending');
    expect(created.id).toBeTruthy();
    expect(created.sourceType).toBe('git');
    expect(created.sourceRef).toBe('https://example.com/repo.git');
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it('reads a deployment by id and returns null when missing', () => {
    const repo = createDeploymentRepository(db);
    expect(repo.getById('missing')).toBeNull();
    const created = repo.create({ sourceType: 'upload', sourceRef: 'artifact-123' });
    const fetched = repo.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.sourceType).toBe('upload');
  });

  it('lists deployments newest-first', () => {
    const repo = createDeploymentRepository(db);
    const a = repo.create({ sourceType: 'git', sourceRef: 'a' });
    db.prepare(
      `UPDATE deployments SET createdAt = ?, updatedAt = ? WHERE id = ?`,
    ).run('2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', a.id);
    const b = repo.create({ sourceType: 'git', sourceRef: 'b' });
    const list = repo.list();
    expect(list.map((d) => d.id)).toEqual([b.id, a.id]);
  });

  it('updates mutable fields', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ sourceType: 'git', sourceRef: 'r' });
    const updated = repo.updateFields(d.id, {
      imageTag: 'dep-1:abc',
      containerId: 'c1',
      routePath: '/d/1',
      liveUrl: 'http://localhost/d/1',
    });
    expect(updated.imageTag).toBe('dep-1:abc');
    expect(updated.containerId).toBe('c1');
    expect(updated.routePath).toBe('/d/1');
    expect(updated.liveUrl).toBe('http://localhost/d/1');
    expect(updated.updatedAt).toBeTruthy();
  });

  it('advances status through the happy path', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ sourceType: 'git', sourceRef: 'r' });
    expect(repo.updateStatus(d.id, 'building').status).toBe('building');
    expect(repo.updateStatus(d.id, 'deploying').status).toBe('deploying');
    expect(repo.updateStatus(d.id, 'running').status).toBe('running');
  });

  it('allows any non-terminal state to transition to failed', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ sourceType: 'git', sourceRef: 'r' });
    expect(repo.updateStatus(d.id, 'failed').status).toBe('failed');
  });

  it('rejects invalid status transitions', () => {
    const repo = createDeploymentRepository(db);
    const d = repo.create({ sourceType: 'git', sourceRef: 'r' });
    expect(() => repo.updateStatus(d.id, 'running')).toThrow(InvalidStatusTransitionError);
    repo.updateStatus(d.id, 'building');
    repo.updateStatus(d.id, 'deploying');
    repo.updateStatus(d.id, 'running');
    expect(() => repo.updateStatus(d.id, 'failed')).toThrow(InvalidStatusTransitionError);
  });

  it('throws when updating a missing deployment', () => {
    const repo = createDeploymentRepository(db);
    expect(() => repo.updateStatus('nope', 'building')).toThrow(DeploymentNotFoundError);
    expect(() => repo.updateFields('nope', { imageTag: 'x' })).toThrow(DeploymentNotFoundError);
  });

  it('exposes isValidStatusTransition helper', () => {
    expect(isValidStatusTransition('pending', 'building')).toBe(true);
    expect(isValidStatusTransition('pending', 'deploying')).toBe(false);
    expect(isValidStatusTransition('running', 'failed')).toBe(false);
  });
});

describe('log repository', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('appends logs with monotonic per-deployment sequence numbers', () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d1 = deployments.create({ sourceType: 'git', sourceRef: 'a' });
    const d2 = deployments.create({ sourceType: 'git', sourceRef: 'b' });

    const l1 = logs.append({ deploymentId: d1.id, stage: 'build', message: 'one' });
    const l2 = logs.append({ deploymentId: d1.id, stage: 'build', message: 'two' });
    const l3 = logs.append({ deploymentId: d2.id, stage: 'build', message: 'other' });
    const l4 = logs.append({ deploymentId: d1.id, stage: 'deploy', message: 'three' });

    expect(l1.sequence).toBe(1);
    expect(l2.sequence).toBe(2);
    expect(l3.sequence).toBe(1); // independent sequence per deployment
    expect(l4.sequence).toBe(3);
  });

  it('reads logs ordered by sequence and supports afterSequence cursor', () => {
    const deployments = createDeploymentRepository(db);
    const logs = createLogRepository(db);
    const d = deployments.create({ sourceType: 'git', sourceRef: 'r' });

    logs.append({ deploymentId: d.id, stage: 'build', message: 'a' });
    logs.append({ deploymentId: d.id, stage: 'build', message: 'b' });
    logs.append({ deploymentId: d.id, stage: 'deploy', message: 'c' });

    const all = logs.listByDeployment(d.id);
    expect(all.map((e) => e.message)).toEqual(['a', 'b', 'c']);
    expect(all.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const tail = logs.listByDeployment(d.id, { afterSequence: 1 });
    expect(tail.map((e) => e.message)).toEqual(['b', 'c']);
  });
});
