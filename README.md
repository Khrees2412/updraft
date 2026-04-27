# Updraft

A local deployment pipeline. Paste a Git URL or pick a project folder, and it builds a container image with Railpack, runs it via Docker, and routes traffic through Caddy — all from `docker compose up`.

## Running it

```bash
git clone <repo>
cd updraft
docker compose up --build
```

Open **http://localhost:8080**. No env vars required — sensible defaults are baked in.

**To deploy the bundled sample app**, use the Upload tab in the UI: click the folder picker and select `apps/sample-app/`. The browser packages it into a tar archive automatically — no manual archiving needed.

Or paste any public Git URL in the Git tab — Railpack will detect the framework automatically.

Once a deployment reaches `running`, click its live URL (`http://localhost:8080/d/<id>`) — that's going through Caddy, not directly to the container.

## How it fits together

```
Browser
  └─► Caddy :8080
        ├─► /api/*     → api:8088
        ├─► /d/:id/*   → dep-<id>:3000   (registered dynamically per deployment)
        └─► /*         → frontend:3000
```

The API owns everything: SQLite persistence, the pipeline worker queue, and the SSE broker. The frontend is a Vite + React SPA — TanStack Query polls the deployments list, and a native `EventSource` handles the log stream.

**Status states:** `pending → building → deploying → running`. Any non-terminal state can transition to `failed` or `cancelled`. `running`, `failed`, and `cancelled` are terminal. The UI shows a Cancel button for in-progress deployments and a Retry button for failed ones.

**Pipeline stages:**

1. `pending → building` — git clone or tar extract into a workspace dir, then `railpack build <workspace> --name dep-<id>:<ts>` (with BuildKit cache flags if a prior build exists for this source)
2. `building → deploying` — dockerode starts a new container under a revision name, health-checks it until running, then renames it to the stable slot (`dep-<id>`); the old container is drained asynchronously
3. `deploying → running` — route `/d/<id>` persisted, pushed to Caddy Admin API, deployment is live

**Redeploy / rollback** — every successful build is recorded in `deployment_builds`. You can list history with `GET /api/deployments/:id/builds`, then queue either `POST /api/deployments/:id/redeploy` or `POST /api/deployments/:id/rollback` with `{ "image_tag": "dep-...:..." }`. These flows reuse the image tag and skip Railpack entirely. The log viewer shows image history and exposes Redeploy / Rollback buttons for each prior tag.

Failure at any stage sets status to `failed` and writes an error log entry — the terminal error shows up in the log viewer.

**Log streaming** — `GET /deployments/:id/logs/stream` replays historical rows from SQLite first, then switches to live events from an in-process pub/sub broker. The client reconnects automatically on disconnect and resumes from the last `sequence` via `Last-Event-ID`, so nothing is lost across reconnects.

**Caddy routing** — static routes for `/api` and `/` are in `infra/caddy/caddy.json`. When a deployment finishes, the API calls Caddy's Admin API to insert a `reverse_proxy` route for `/d/:id` pointing at `dep-<id>:3000` on the internal Docker network. No Caddyfile reloads, no restarts. On API startup, all `running` deployments have their routes re-registered — so a Caddy or API restart doesn't blank out live deployments.

**Asset path fix** — Railpack-built apps default to absolute asset paths (`/assets/app.js`). Without intervention, the browser would fetch those from the root, hitting the Updraft SPA instead of the deployed container. Caddy injects `<base href="/d/:id/">` into every HTML response from a deployed container so relative resolution works correctly without requiring any changes to the deployed app.

## API reference

All routes are under `/api` (Caddy strips the prefix before forwarding to the API on `:8088`).

All responses follow the envelope:

```json
{ "success": true, "message": "...", "data": <payload> }
```

Errors return the same shape with `"success": false` and an appropriate HTTP status.

### Deployments

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/deployments` | Create and enqueue a new deployment |
| `GET` | `/api/deployments` | List all deployments, newest first |
| `GET` | `/api/deployments/:id` | Get a single deployment |
| `GET` | `/api/deployments/:id/builds` | List prior image builds for the same source |
| `POST` | `/api/deployments/:id/cancel` | Cancel a non-terminal deployment |
| `POST` | `/api/deployments/:id/retry` | Re-queue a failed deployment from scratch |
| `POST` | `/api/deployments/:id/redeploy` | Deploy a prior image tag (skips Railpack) |
| `POST` | `/api/deployments/:id/rollback` | Alias of redeploy — same behaviour, different intent |
| `GET` | `/api/deployments/:id/logs/stream` | SSE stream of build + deploy logs |

**`POST /api/deployments`** — two accepted content types:

```
# Git URL
Content-Type: application/json
{ "git_url": "https://github.com/user/repo" }

# Folder upload
Content-Type: multipart/form-data
archive=<tar file>   (field name must be "archive")
```

Returns `201` with the created `Deployment` object.

**`POST /api/deployments/:id/redeploy`** and **`POST /api/deployments/:id/rollback`**:

```json
{ "image_tag": "dep-<id>:<timestamp>" }
```

`image_tag` must be a value returned from `GET /api/deployments/:id/builds`. Creates a new deployment row that reuses the existing image — Railpack is skipped entirely.

**`GET /api/deployments/:id/logs/stream`** — Server-Sent Events, three event types:

| Event | Data |
|-------|------|
| `log` | `DeploymentLogEvent` — `{ id, deployment_id, stage, message, timestamp, sequence }` |
| `status` | `{ deployment_id, status }` — fired on every status transition |
| `done` | `{ status }` — fired once when a terminal status is reached; client should close |

Resume after reconnect by passing the last received `sequence` as `Last-Event-ID` (standard SSE) or `?afterSequence=<n>` (query param fallback). Historical logs are replayed from SQLite before switching to the live broker.

### Data shapes

```typescript
type DeploymentStatus = 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'cancelled';
type DeploymentSourceType = 'git' | 'upload';
type LogStage = 'build' | 'deploy' | 'system';

interface Deployment {
  id: string;
  source_type: DeploymentSourceType;
  source_ref: string;           // git URL or upload filename
  status: DeploymentStatus;
  image_tag?: string;           // set once Railpack build completes
  container_id?: string;
  container_name?: string;      // dep-<id> — stable name Caddy routes to
  internal_port?: number;
  route_path?: string;          // /d/<id>
  live_url?: string;            // http://localhost:8080/d/<id>
  previous_container_id?: string;
  previous_container_name?: string;
  created_at: string;           // ISO 8601
  updated_at: string;
}

interface DeploymentLogEvent {
  id: string;
  deployment_id: string;
  stage: LogStage;
  message: string;
  timestamp: string;
  sequence: number;             // monotonically increasing, used for SSE resume
}

interface DeploymentBuild {
  id: string;
  source_type: DeploymentSourceType;
  source_ref: string;
  image_tag: string;
  build_method: 'railpack' | 'reused';
  created_by_deployment_id: string;
  created_at: string;
}
```

### Health check

```
GET /health  →  200 { status: "ok" }
```

## Environment variables

All have defaults — nothing needs to be set for local development.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8088` | API listen port |
| `DB_PATH` | `/data/updraft.db` | SQLite database file path |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Base URL used to construct `live_url` |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy Admin API endpoint |
| `DEPLOYMENT_NETWORK` | `updraft_deployments` | Docker network deployment containers join |
| `APP_INTERNAL_PORT` | `3000` | Port the deployed container is expected to listen on |
| `UPLOAD_DIR` | `<cwd>/data/uploads` | Where uploaded tar archives are stored |
| `WORKSPACE_ROOT` | `/app/workspaces` | Where source is extracted before building |
| `BUILDKIT_HOST` | `docker-container://updraft-buildkit-1` | BuildKit gRPC endpoint for Railpack |
| `BUILD_CACHE_DIR` | `/tmp/updraft-cache` | Local BuildKit layer cache directory |
| `BUILD_CACHE_REGISTRY` | unset | If set, use registry cache instead of local dir |
| `DRAIN_TIMEOUT_MS` | `10000` | How long to wait for old container to drain before SIGKILL |

## Repo layout

```
apps/
  api/          Hono API — pipeline, SQLite, SSE broker
  frontend/     Vite + React SPA — TanStack Router + Query
  sample-app/   Minimal Node.js app for testing deployments
packages/
  shared-types/ TypeScript types shared between API and frontend
infra/
  caddy/        caddy.json — static routes loaded at startup
docker-compose.yml
```

## Build cache reuse (B-02)

Every time Railpack builds from a given source (git URL or upload path), the build step:

1. Computes a stable cache key — 16-char SHA-256 of `source_type:source_ref`
2. Checks `build_cache` in SQLite for a prior entry under that key
3. Logs `[cache] HIT key=... hits=N` or `[cache] MISS key=...` at build start
4. Passes `--cache-from` (on hits) and `--cache-to` (always) to `railpack build` so BuildKit reuses layer state

Cache references default to a local directory (`BUILD_CACHE_DIR`, default `/tmp/updraft-cache`). Set `BUILD_CACHE_REGISTRY` to a registry host to use remote cache storage instead (`type=registry`).

The `build_cache` table tracks `source_key`, `cache_ref`, `last_used_at`, and `hit_count` — all visible in the SQLite file if you want to inspect or prune cache entries manually.

## Zero-downtime redeploy handoff (B-03)

Every deploy uses a two-container swap instead of a stop-then-start:

1. Start new container under a timestamped revision name: `dep-<id>-rev-<ts>`
2. Health-check it until `running` (or timeout → `failed`)
3. Rename the existing stable container away from its slot
4. Rename the revision container to the stable slot (`dep-<id>`) — Caddy keeps routing to the same hostname with no config change
5. Drain the old container asynchronously: SIGTERM, wait up to `DRAIN_TIMEOUT_MS` (default 10 s), then SIGKILL + remove

Because Caddy always proxies to `dep-<id>` by name and the rename is atomic from Docker's perspective, in-flight requests complete against the old container while new requests go to the new one. The previous container's ID and name are stored on the deployment row (`previous_container_id`, `previous_container_name`) for audit purposes.

Drain failures are logged as warnings and never fail the deployment — if the old container is already gone, the step is a no-op.

## Decisions I'd defend

**Path-based routing over subdomains** — subdomains require wildcard DNS or `/etc/hosts` hacks on a clean machine. `/d/:id` works out of the box. In production you'd flip to subdomains once you control DNS.

**SSE over WebSockets** — logs are one-directional. SSE is HTTP-native, auto-reconnects, and requires nothing special from the client. I'd only reach for WebSockets if the channel needed to be bidirectional.

**SQLite over Postgres** — single writer, local machine, zero config. The repository layer is thin enough that swapping in `pg` later is a one-file change.

**In-process queue** — a `Set` + async runner. No Redis dependency for a single-machine sandbox. The tradeoff is that in-flight jobs are lost on restart — acceptable here, would not be acceptable in production.

**Railpack over Dockerfiles** — the point is zero-config builds. Railpack detects the framework, handles the image. The tradeoff is less control over the output image; acceptable for this use case.

**Docker socket mount** — required for two things: Railpack uses it (via the mounted socket and the BuildKit sidecar) to build and import images, and dockerode uses it to create, inspect, rename, and stop containers. Known risk: socket access is root-equivalent on the host. Fine for local dev, never in production.

## What I'd change with more time

**Persistent queue** — right now in-flight jobs are gone if the API restarts. A startup sweep of `pending`/`building` rows would fix this in maybe 20 lines.

**Frontend push instead of poll** — the deployments list polls every 3 s. An SSE channel for status updates would eliminate the delay without much more complexity.

**Upload validation** — the API's upload path runs `tar -xf` on whatever arrives. The UI always sends a valid tar (packed client-side), but a direct API call with a `.zip` body would fail silently at extraction. Should validate the content type and branch on format.

**Cache eviction** — the `build_cache` table grows unboundedly. A simple LRU sweep keyed on `last_used_at` would keep disk usage bounded; not implemented because there's no cache size pressure in local dev.

## What broke while building this

The build was mostly straightforward but a few things bit me enough to be worth naming.

**State machine bug — `running` was treated as terminal.** Early on, the SSE stream sent a `done` event as soon as the deployment reached `running`, which closed the log viewer immediately. The bug was subtle: `running` was in the same terminal-state check as `failed`. In hindsight it's obvious — `running` means the container is up, not that the pipeline is *done* — but it took a moment to notice because the UI looked fine until you tried to keep watching logs after a fast build.

**Routes wired but not mounted.** Spent time debugging 404s on `/deployments` before realising the router was implemented correctly but never attached in `index.ts`. The health endpoint worked because it was mounted first; everything else silently fell through. Classic "it's always the last thing you check" moment.

**`node:sqlite` type error.** Started with Node's built-in `node:sqlite` (landed in Node 22 as experimental) — no type declarations exist for it yet. Switched to `better-sqlite3`, which is battle-tested and has solid types.

**`Database.Database` naming.** `better-sqlite3` exports a class called `Database`, so the instance type ends up as `Database.Database` everywhere it's referenced. Ugly enough to fix immediately with a type alias.

**snake_case vs camelCase drift.** The DB schema was snake_case, the API responses were camelCase, and the shared types were inconsistent. This caused silent mismatches between what the frontend expected and what the API returned. Fixed in one pass by committing to snake_case end-to-end — DB columns, API payloads, shared types — and switching from UUID to nanoid with an alphabet of lowercase letters only (no hyphens or numbers, which read poorly in URLs and log output).

**CLI vs SDK for Docker.** The first version shelled out to the `docker` CLI to start containers — `child_process.exec('docker run ...')`. It worked but felt wrong: no structured error handling, no way to stream container inspect state, string-parsing output to get container IDs. Switched to `dockerode` (the official Node SDK), which made the runner cleaner and testable with fakes.

**Docker Compose teardown blocking on a running container.** Running `docker compose down -v` during testing would fail with "cannot remove container" if a deployment container was still up — Compose only manages the services it defined, not the containers the API spawned dynamically. Workaround: `docker rm -f` the deployment containers first, or just `down` without `-v` when iterating. Not fixed in the codebase — it's an expected operational constraint with dynamically-managed containers.

**`nginx:alpine` failing to pull during frontend image build.** Hit a DNS/registry resolution failure on `docker.io/library/nginx:alpine` partway through development — the build would stall at the `FROM` line. Turned out to be a transient Docker Hub rate-limit / network issue rather than a code problem. Switched the frontend Dockerfile to use a pinned digest as a fallback, then it cleared up on its own.

**Caddy routes lost on restart.** Dynamic Caddy routes live in memory only — a Caddy or API restart wiped all deployment routes and left running containers unreachable. Fixed by re-registering all `running` deployments' routes at API startup.

**Absolute asset paths breaking deployed apps.** Railpack-built Vite/Bun apps default to `base: "/"`, so their HTML references `/assets/app.js`. The browser fetches that from the root, which hits the Updraft frontend SPA instead of the deployed container — CSS and JS silently missing. Fixed by having Caddy inject `<base href="/d/:id/">` into HTML responses from deployed containers.

## What I'd rip out

The `dist/` test files end up in the vitest run alongside the `src/` files — they're duplicates. A one-line include pattern in `vitest.config.ts` fixes it, I just didn't get to it.

## Tests

```bash
pnpm --filter @updraft/api exec vitest run
```

128 tests, all passing. Coverage focuses on the pipeline worker (happy path + every failure mode), the repository layer (status transitions, log ordering), the deployment routes, and the build cache and zero-downtime handoff logic.

## Brimble deploy + feedback

> **Deployed:** https://updraft.brimble.app/

**How the deploy is set up:**

The frontend is deployed as a static SPA. Brimble settings:

| Setting | Value |
|---|---|
| Install command | `pnpm install` |
| Build command | `pnpm build:brimble` |
| Output directory | `public` |
| Root directory | `.` (repo root) |

`pnpm build:brimble` runs `pnpm --filter @updraft/frontend build` (Vite build) and copies the output to `public/` at the repo root. The `brimble.json` SPA rewrite (`/* → /index.html`) is at the repo root.

The Vite config resolves `@updraft/shared-types` directly from its TypeScript source via a `resolve.alias`, so there's no need to pre-build the package before the frontend build.

**Feedback:**

The deploy itself went smoothly — Node.js was auto-detected so I switched to Vite, the build ran clean on first try, and the SPA rewrite config (`brimble.json`) was picked up without any extra steps. No friction getting it live.

The one friction point I hit is that the free plan is static sites only. The deployed app shows an error on load — `Unexpected token '<'... is not valid JSON` — because the "Recent Deployments" panel calls `/api/deployments`, gets back a Brimble 404 HTML page, and tries to parse it as JSON. Deploying the backend (the Hono API, SQLite, the pipeline worker) alongside the frontend requires a paid plan. That's a reasonable business decision, but it's not obvious from the deploy UI — there's no callout explaining why backend routes won't work on the free tier or prompting an upgrade path.

A few things I'd change: the error state in the UI could be friendlier — right now it surfaces a raw JSON parse error rather than "can't reach the API." And the docs don't cover monorepo setups at all — I had to guess at the install/build command pairing (`pnpm install` + `pnpm build:brimble` from the repo root); a short monorepo guide would save time. The import flow does expose build command / output directory / install command fields, but there's no documentation on what to put in them for a pnpm workspace.

One more issue worth flagging: a Bun app I deployed through Updraft had its CSS silently not load — the JS rendered but the page was completely unstyled. This turned out to be an asset path issue (Railpack-built apps use absolute paths by default), not a Brimble issue — but the failure mode is identical and equally hard to debug without knowing what to look for. Surfacing 404s for stylesheet requests more visibly would help in both contexts.
