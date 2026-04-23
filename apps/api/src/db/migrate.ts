import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id          TEXT PRIMARY KEY,
      sourceType  TEXT NOT NULL CHECK(sourceType IN ('git', 'upload')),
      sourceRef   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','building','deploying','running','failed')),
      imageTag    TEXT,
      containerId TEXT,
      routePath   TEXT,
      liveUrl     TEXT,
      createdAt   TEXT NOT NULL,
      updatedAt   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployment_logs (
      id           TEXT PRIMARY KEY,
      deploymentId TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      stage        TEXT NOT NULL CHECK(stage IN ('build','deploy','system')),
      message      TEXT NOT NULL,
      timestamp    TEXT NOT NULL,
      sequence     INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deployment_logs_deployment
      ON deployment_logs(deploymentId, sequence);
  `);
}
