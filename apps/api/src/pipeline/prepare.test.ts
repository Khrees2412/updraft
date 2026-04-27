import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "./prepare.js";
import type { StageLogger } from "./logger.js";

function loggerStub(): StageLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    async log(msg) {
      lines.push(msg);
    },
    async status() {},
  };
}

describe("prepareWorkspace", () => {
  let workspacePath: string;
  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "updraft-prep-"));
  });
  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  it("does nothing when there is no bun lockfile", async () => {
    fs.writeFileSync(path.join(workspacePath, "package.json"), "{}");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });
    expect(fs.existsSync(path.join(workspacePath, "railpack.json"))).toBe(
      false,
    );
    expect(logger.lines).toHaveLength(0);
  });

  it("injects railpack.json for bun.lockb projects", async () => {
    fs.writeFileSync(path.join(workspacePath, "bun.lockb"), "");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const configPath = path.join(workspacePath, "railpack.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.steps.install.commands).toEqual([
      { src: "package.json", dest: "package.json" },
      { src: "bun.lockb", dest: "bun.lockb" },
      { cmd: "bun install" },
    ]);
    expect(logger.lines.some((l) => l.includes("bun project"))).toBe(true);
  });

  it("injects railpack.json for bun.lock (text format) projects", async () => {
    fs.writeFileSync(path.join(workspacePath, "bun.lock"), "");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const configPath = path.join(workspacePath, "railpack.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.steps.install.commands).toEqual([
      { src: "package.json", dest: "package.json" },
      { src: "bun.lock", dest: "bun.lock" },
      { cmd: "bun install" },
    ]);
  });

  it("respects user-provided railpack.json and does not overwrite", async () => {
    fs.writeFileSync(path.join(workspacePath, "bun.lockb"), "");
    const userConfig = '{"provider":"node"}';
    fs.writeFileSync(path.join(workspacePath, "railpack.json"), userConfig);
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });
    expect(
      fs.readFileSync(path.join(workspacePath, "railpack.json"), "utf8"),
    ).toBe(userConfig);
    expect(logger.lines).toHaveLength(0);
  });

  it("respects user-provided railpack.toml and does not overwrite", async () => {
    fs.writeFileSync(path.join(workspacePath, "bun.lockb"), "");
    fs.writeFileSync(
      path.join(workspacePath, "railpack.toml"),
      'provider = "node"',
    );
    await prepareWorkspace({ workspacePath, logger: loggerStub() });
    expect(fs.existsSync(path.join(workspacePath, "railpack.json"))).toBe(
      false,
    );
  });
});
