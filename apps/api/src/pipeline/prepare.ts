import fs from "node:fs";
import path from "node:path";
import type { StageLogger } from "./logger.js";

export interface PrepareInput {
  workspacePath: string;
  logger: StageLogger;
}

// Railpack hard-codes `bun install --frozen-lockfile`, which fails when the
// uploaded lockfile drifts from package.json or was generated on a different
// architecture (common: lockfile from darwin/arm64, build runs on linux/amd64
// where optional native deps resolve differently). We can't override railpack's
// install command via env vars, but railpack *does* read `railpack.json` from
// the workspace root and lets it override step commands.
//
// If the user already shipped a railpack.json we leave it alone — they've
// opted in to whatever they configured. Otherwise, for bun projects, we drop
// in a minimal config that swaps `bun install --frozen-lockfile` for plain
// `bun install`. The workspace is a fresh copy of the user's source (cloned
// or extracted), so this never mutates anything outside our sandbox.
export async function prepareWorkspace({
  workspacePath,
  logger,
}: PrepareInput): Promise<void> {
  const hasRailpackConfig =
    fs.existsSync(path.join(workspacePath, "railpack.json")) ||
    fs.existsSync(path.join(workspacePath, "railpack.toml"));
  if (hasRailpackConfig) return;

  const isBun =
    fs.existsSync(path.join(workspacePath, "bun.lockb")) ||
    fs.existsSync(path.join(workspacePath, "bun.lock"));
  if (!isBun) return;

  const hasBunLockb = fs.existsSync(path.join(workspacePath, "bun.lockb"));
  const lockfileName = hasBunLockb ? "bun.lockb" : "bun.lock";

  const config = {
    steps: {
      install: {
        commands: [
          { src: "package.json", dest: "package.json" },
          { src: lockfileName, dest: lockfileName },
          { cmd: "bun install" },
        ],
      },
    },
  };
  fs.writeFileSync(
    path.join(workspacePath, "railpack.json"),
    JSON.stringify(config, null, 2),
  );
  await logger.log(
    "[prepare] Detected bun project; injected railpack.json to relax lockfile check",
  );
}
