import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import health from "./routes/health.js";
import { createDeploymentsRouter } from "./routes/deployments.js";
import { getPipelineQueue } from "./pipeline/index.js";
import { createDeploymentRepository } from "./db/repository.js";
import { createCaddyRouteRegistrar } from "./pipeline/caddy.js";

const db = getDb();
runMigrations(db);
getPipelineQueue(db);

const app = new Hono();

app.route("/health", health);
app.route("/deployments", createDeploymentsRouter(db));

const PORT = Number(process.env["PORT"] ?? 8088);

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`API listening on port ${PORT}`);
  restoreCaddyRoutes();
});

// Re-register Caddy routes for all running deployments on startup.
// Caddy stores routes in memory only — they're lost on restart.
async function restoreCaddyRoutes() {
  const repo = createDeploymentRepository(db);
  const registrar = createCaddyRouteRegistrar();
  const running = repo.list().filter(
    (d) => d.status === 'running' && d.container_name && d.internal_port && d.route_path,
  );
  if (running.length === 0) return;
  console.log(`[startup] Restoring ${running.length} Caddy route(s) for running deployments`);
  for (const d of running) {
    try {
      await registrar.register({
        deploymentId: d.id,
        containerName: d.container_name!,
        internalPort: d.internal_port!,
      });
      console.log(`[startup] Restored route for ${d.id} → ${d.container_name}`);
    } catch (err) {
      console.error(`[startup] Failed to restore route for ${d.id}:`, err);
    }
  }
}
