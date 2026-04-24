import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  Deployment,
  DeploymentLogEvent,
  DeploymentSourceType,
  DeploymentStatus,
  LogStage,
} from '@updraft/shared-types';

type DeploymentRow = {
  id: string;
  sourceType: string;
  sourceRef: string;
  status: string;
  imageTag: string | null;
  containerId: string | null;
  routePath: string | null;
  liveUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

type DeploymentLogRow = {
  id: string;
  deploymentId: string;
  stage: string;
  message: string;
  timestamp: string;
  sequence: number;
};

function rowToDeployment(row: DeploymentRow): Deployment {
  const d: Deployment = {
    id: row.id,
    sourceType: row.sourceType as DeploymentSourceType,
    sourceRef: row.sourceRef,
    status: row.status as DeploymentStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.imageTag !== null) d.imageTag = row.imageTag;
  if (row.containerId !== null) d.containerId = row.containerId;
  if (row.routePath !== null) d.routePath = row.routePath;
  if (row.liveUrl !== null) d.liveUrl = row.liveUrl;
  return d;
}

function rowToLogEvent(row: DeploymentLogRow): DeploymentLogEvent {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    stage: row.stage as LogStage,
    message: row.message,
    timestamp: row.timestamp,
    sequence: row.sequence,
  };
}

// Deployment lifecycle: pending -> building -> deploying -> live.
// Any non-terminal state may transition to failed or cancelled. live/failed/cancelled are terminal.
const ALLOWED_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  pending: ['building', 'failed', 'cancelled'],
  building: ['deploying', 'failed', 'cancelled'],
  deploying: ['live', 'failed', 'cancelled'],
  live: [],
  failed: [],
  cancelled: [],
};

export function isValidStatusTransition(
  from: DeploymentStatus,
  to: DeploymentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidStatusTransitionError extends Error {
  constructor(from: DeploymentStatus, to: DeploymentStatus) {
    super(`Invalid deployment status transition: ${from} -> ${to}`);
    this.name = 'InvalidStatusTransitionError';
  }
}

export class DeploymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Deployment not found: ${id}`);
    this.name = 'DeploymentNotFoundError';
  }
}

export interface CreateDeploymentInput {
  sourceType: DeploymentSourceType;
  sourceRef: string;
}

export interface UpdateDeploymentInput {
  imageTag?: string;
  containerId?: string;
  routePath?: string;
  liveUrl?: string;
}

export function createDeploymentRepository(db: Database.Database) {
  return {
    create(input: CreateDeploymentInput): Deployment {
      const now = new Date().toISOString();
      const id = randomUUID();
      db.prepare(
        `INSERT INTO deployments (id, sourceType, sourceRef, status, createdAt, updatedAt)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(id, input.sourceType, input.sourceRef, now, now);
      return {
        id,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
    },

    getById(id: string): Deployment | null {
      const row = db
        .prepare(`SELECT * FROM deployments WHERE id = ?`)
        .get(id) as DeploymentRow | undefined;
      return row ? rowToDeployment(row) : null;
    },

    list(): Deployment[] {
      const rows = db
        .prepare(`SELECT * FROM deployments ORDER BY createdAt DESC`)
        .all() as DeploymentRow[];
      return rows.map(rowToDeployment);
    },

    claim(): Deployment | null {
      const row = db
        .prepare(
          `UPDATE deployments SET status = 'building', updatedAt = ? 
           WHERE id = (SELECT id FROM deployments WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1)
           RETURNING *`,
        )
        .get(new Date().toISOString()) as DeploymentRow | undefined;
      return row ? rowToDeployment(row) : null;
    },

    updateStatus(id: string, next: DeploymentStatus): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      if (!isValidStatusTransition(current.status, next)) {
        throw new InvalidStatusTransitionError(current.status, next);
      }
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE deployments SET status = ?, updatedAt = ? WHERE id = ?`,
      ).run(next, now, id);
      return { ...current, status: next, updatedAt: now };
    },

    updateStatusWithLog(
      id: string,
      next: DeploymentStatus,
      logStage: LogStage,
      logMessage: string,
    ): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      if (!isValidStatusTransition(current.status, next)) {
        throw new InvalidStatusTransitionError(current.status, next);
      }
      const now = new Date().toISOString();
      const run = db.transaction(() => {
        db.prepare(
          `UPDATE deployments SET status = ?, updatedAt = ? WHERE id = ?`,
        ).run(next, now, id);
        const seqRow = db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM deployment_logs WHERE deploymentId = ?`,
          )
          .get(id) as { next: number };
        const seq = seqRow.next;
        db.prepare(
          `INSERT INTO deployment_logs (id, deploymentId, stage, message, timestamp, sequence)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), id, logStage, logMessage, now, seq);
      });
      run();
      return { ...current, status: next, updatedAt: now };
    },

    updateFields(id: string, fields: UpdateDeploymentInput): Deployment {
      const current = this.getById(id);
      if (!current) throw new DeploymentNotFoundError(id);
      const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return current;
      const now = new Date().toISOString();
      const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
      const values = entries.map(([, v]) => v as string);
      db.prepare(
        `UPDATE deployments SET ${setClause}, updatedAt = ? WHERE id = ?`,
      ).run(...values, now, id);
      return this.getById(id)!;
    },
  };
}

export function createLogRepository(db: Database.Database) {
  return {
    append(input: {
      deploymentId: string;
      stage: LogStage;
      message: string;
    }): DeploymentLogEvent {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      // MAX(sequence) + 1 scoped per deployment; COALESCE handles the empty case (gives 1).
      const seqRow = db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM deployment_logs WHERE deploymentId = ?`,
        )
        .get(input.deploymentId) as { next: number };
      const sequence = seqRow.next;
      db.prepare(
        `INSERT INTO deployment_logs (id, deploymentId, stage, message, timestamp, sequence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.deploymentId, input.stage, input.message, timestamp, sequence);
      return {
        id,
        deploymentId: input.deploymentId,
        stage: input.stage,
        message: input.message,
        timestamp,
        sequence,
      };
    },

    listByDeployment(
      deploymentId: string,
      opts: { afterSequence?: number } = {},
    ): DeploymentLogEvent[] {
      const after = opts.afterSequence ?? 0;
      const rows = db
        .prepare(
          `SELECT * FROM deployment_logs
           WHERE deploymentId = ? AND sequence > ?
           ORDER BY sequence ASC`,
        )
        .all(deploymentId, after) as DeploymentLogRow[];
      return rows.map(rowToLogEvent);
    },
  };
}

export type DeploymentRepository = ReturnType<typeof createDeploymentRepository>;
export type LogRepository = ReturnType<typeof createLogRepository>;
