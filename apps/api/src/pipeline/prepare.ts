import fs from "node:fs";
import path from "node:path";
import type { StageLogger } from "./logger.js";

export interface PrepareInput {
  workspacePath: string;
  logger: StageLogger;
}

// Railpack hard-codes frozen/locked installs for most package managers, which
// fails when the lockfile was generated on a different architecture (common:
// darwin/arm64 dev machine, linux/amd64 build). We can't override railpack's
// install commands via env vars, but railpack reads `railpack.json` from the
// workspace root and lets it override step commands.
//
// If the user already shipped a railpack.json/toml we leave it alone — they've
// opted in to whatever they configured. Otherwise we inject a minimal config
// that drops the frozen/locked flag. The workspace is a fresh copy of the
// user's source, so this never mutates anything outside our sandbox.

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function writeRailpackJson(
  workspacePath: string,
  config: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(workspacePath, "railpack.json"),
    JSON.stringify(config, null, 2),
  );
}

export async function prepareWorkspace({
  workspacePath,
  logger,
}: PrepareInput): Promise<void> {
  const hasRailpackConfig =
    exists(path.join(workspacePath, "railpack.json")) ||
    exists(path.join(workspacePath, "railpack.toml"));
  if (hasRailpackConfig) return;

  const w = (f: string) => path.join(workspacePath, f);

  // --- Bun ---
  // bun install --frozen-lockfile fails on cross-arch lockfile drift.
  if (exists(w("bun.lockb")) || exists(w("bun.lock"))) {
    const lockfileName = exists(w("bun.lockb")) ? "bun.lockb" : "bun.lock";
    writeRailpackJson(workspacePath, {
      steps: {
        install: {
          commands: [
            { src: "package.json", dest: "package.json" },
            { src: lockfileName, dest: lockfileName },
            { cmd: "bun install" },
          ],
        },
      },
    });
    await logger.log(
      "[prepare] Detected bun project; injected railpack.json to relax lockfile check",
    );
    return;
  }

  // --- pnpm ---
  // pnpm install --frozen-lockfile fails when platform-specific optional deps
  // in the lockfile don't match the build platform (darwin/arm64 → linux/amd64).
  if (exists(w("pnpm-lock.yaml"))) {
    writeRailpackJson(workspacePath, {
      steps: {
        install: {
          commands: [
            { src: "package.json", dest: "package.json" },
            { src: "pnpm-lock.yaml", dest: "pnpm-lock.yaml" },
            { cmd: "pnpm install --no-frozen-lockfile" },
          ],
        },
      },
    });
    await logger.log(
      "[prepare] Detected pnpm project; injected railpack.json to relax lockfile check",
    );
    return;
  }

  // --- Yarn (Classic v1 and Berry v2+) ---
  // yarn install --frozen-lockfile (v1) / yarn install --immutable (v2+) fail
  // on cross-arch lockfile drift for platform-specific optional packages.
  if (exists(w("yarn.lock"))) {
    const isBerry = (() => {
      try {
        const rc = fs.readFileSync(w(".yarnrc.yml"), "utf8");
        return rc.includes("nodeLinker") || rc.includes("yarnPath");
      } catch {
        return false;
      }
    })();
    const installCmd = isBerry
      ? "yarn install"
      : "yarn install --no-frozen-lockfile";
    writeRailpackJson(workspacePath, {
      steps: {
        install: {
          commands: [
            { src: "package.json", dest: "package.json" },
            { src: "yarn.lock", dest: "yarn.lock" },
            ...(isBerry && exists(w(".yarnrc.yml"))
              ? [{ src: ".yarnrc.yml", dest: ".yarnrc.yml" }]
              : []),
            { cmd: installCmd },
          ],
        },
      },
    });
    await logger.log(
      `[prepare] Detected yarn project (${isBerry ? "berry" : "classic"}); injected railpack.json to relax lockfile check`,
    );
    return;
  }

  // --- Python / Poetry ---
  // poetry install --frozen fails when the lockfile contains platform-specific
  // hashes (e.g. generated on macOS, built on linux/amd64).
  if (exists(w("poetry.lock")) && exists(w("pyproject.toml"))) {
    writeRailpackJson(workspacePath, {
      steps: {
        install: {
          commands: [
            { src: "pyproject.toml", dest: "pyproject.toml" },
            { src: "poetry.lock", dest: "poetry.lock" },
            { cmd: "poetry install --no-interaction" },
          ],
        },
      },
    });
    await logger.log(
      "[prepare] Detected poetry project; injected railpack.json to relax lockfile check",
    );
    return;
  }

  // --- Ruby / Bundler ---
  // bundle install --frozen fails when Gemfile.lock contains platform-specific
  // gems (e.g. darwin-arm64 native gems not available on linux-x86_64).
  if (exists(w("Gemfile.lock")) && exists(w("Gemfile"))) {
    writeRailpackJson(workspacePath, {
      steps: {
        install: {
          commands: [
            { src: "Gemfile", dest: "Gemfile" },
            { src: "Gemfile.lock", dest: "Gemfile.lock" },
            { cmd: "bundle install" },
          ],
        },
      },
    });
    await logger.log(
      "[prepare] Detected bundler project; injected railpack.json to relax lockfile check",
    );
    return;
  }
}
