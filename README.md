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

**Caddy routing** — static routes for `/api` and `/` are in `infra/caddy/caddy.json`. When a deployment finishes, the API calls Caddy's Admin API to insert a `reverse_proxy` route for `/d/:id` pointing at `dep-<id>:3000` on the internal Docker network. No Caddyfile reloads, no restarts.

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

## What I'd rip out

The `dist/` test files end up in the vitest run alongside the `src/` files — they're duplicates. A one-line include pattern in `vitest.config.ts` fixes it, I just didn't get to it.

## Tests

```bash
pnpm --filter @updraft/api exec vitest run
```

128 tests, all passing. Coverage focuses on the pipeline worker (happy path + every failure mode), the repository layer (status transitions, log ordering), the deployment routes, and the build cache and zero-downtime handoff logic.

## Brimble deploy + feedback

> **Deployed:** *(link goes here)*
>
> *(Feedback goes here — fill in after deploying. Be direct: what broke, what was confusing, what you'd change.)*
