# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base

# Build deps for native modules (better-sqlite3) + git for clones
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl ca-certificates

RUN corepack enable && corepack prepare pnpm@9.1.0 --activate

WORKDIR /app

# Workspace manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/api/package.json ./apps/api/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY packages/shared-types/ ./packages/shared-types/
COPY apps/api/ ./apps/api/

RUN pnpm --filter @updraft/shared-types build
RUN pnpm --filter @updraft/api build

RUN pnpm --filter @updraft/api --prod deploy /app/pruned
RUN cp -r apps/api/dist /app/pruned/dist

FROM node:20-bookworm-slim AS runtime

# Runtime deps:
#   git           — clone deployment sources
#   ca-certificates, curl — railpack install + general TLS
#   docker.io     — railpack invokes `docker load` to import the built image
#                    into the host daemon (via the mounted /var/run/docker.sock)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates docker.io

# Railpack CLI — installs to $HOME/.local/bin/railpack
RUN mkdir -p /root/.local/bin \
  && curl -fsSL https://railpack.com/install.sh | sh -s -- -b /root/.local/bin \
  && /root/.local/bin/railpack --version

ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app

COPY --from=base /app/pruned ./

ENV NODE_ENV=production
EXPOSE 8088

CMD ["node", "dist/index.js"]
