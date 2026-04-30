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

  const w = (dir: string, f: string) => path.join(dir, f);
  const railpackJson = (dir: string) => w(dir, "railpack.json");
  const readConfig = (dir: string) =>
    JSON.parse(fs.readFileSync(railpackJson(dir), "utf8"));

  it("does nothing when no known lockfile is present", async () => {
    fs.writeFileSync(w(workspacePath, "package.json"), "{}");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });
    expect(fs.existsSync(railpackJson(workspacePath))).toBe(false);
    expect(logger.lines).toHaveLength(0);
  });

  it("respects user-provided railpack.json and does not overwrite", async () => {
    fs.writeFileSync(w(workspacePath, "bun.lockb"), "");
    const userConfig = '{"provider":"node"}';
    fs.writeFileSync(railpackJson(workspacePath), userConfig);
    await prepareWorkspace({ workspacePath, logger: loggerStub() });
    expect(fs.readFileSync(railpackJson(workspacePath), "utf8")).toBe(
      userConfig,
    );
  });

  it("respects user-provided railpack.toml and does not overwrite", async () => {
    fs.writeFileSync(w(workspacePath, "bun.lockb"), "");
    fs.writeFileSync(w(workspacePath, "railpack.toml"), 'provider = "node"');
    await prepareWorkspace({ workspacePath, logger: loggerStub() });
    expect(fs.existsSync(railpackJson(workspacePath))).toBe(false);
  });

  // --- Bun ---

  it("injects railpack.json for bun.lockb projects", async () => {
    fs.writeFileSync(w(workspacePath, "bun.lockb"), "");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    expect(fs.existsSync(railpackJson(workspacePath))).toBe(true);
    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toEqual([
      { src: "package.json", dest: "package.json" },
      { src: "bun.lockb", dest: "bun.lockb" },
      { cmd: "bun install" },
    ]);
    expect(logger.lines.some((l) => l.includes("bun project"))).toBe(true);
  });

  it("injects railpack.json for bun.lock (text format) projects", async () => {
    fs.writeFileSync(w(workspacePath, "bun.lock"), "");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toEqual([
      { src: "package.json", dest: "package.json" },
      { src: "bun.lock", dest: "bun.lock" },
      { cmd: "bun install" },
    ]);
  });

  // --- pnpm ---

  it("injects railpack.json for pnpm projects", async () => {
    fs.writeFileSync(w(workspacePath, "package.json"), "{}");
    fs.writeFileSync(w(workspacePath, "pnpm-lock.yaml"), "lockfileVersion: 6");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toEqual([
      { src: "package.json", dest: "package.json" },
      { src: "pnpm-lock.yaml", dest: "pnpm-lock.yaml" },
      { cmd: "pnpm install --no-frozen-lockfile" },
    ]);
    expect(logger.lines.some((l) => l.includes("pnpm project"))).toBe(true);
  });

  // --- Yarn ---

  it("injects railpack.json for yarn classic projects", async () => {
    fs.writeFileSync(w(workspacePath, "package.json"), "{}");
    fs.writeFileSync(w(workspacePath, "yarn.lock"), "__metadata:\n  version: 1");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toContainEqual({
      cmd: "yarn install --no-frozen-lockfile",
    });
    expect(logger.lines.some((l) => l.includes("yarn project"))).toBe(true);
  });

  it("injects railpack.json for yarn berry projects", async () => {
    fs.writeFileSync(w(workspacePath, "package.json"), "{}");
    fs.writeFileSync(w(workspacePath, "yarn.lock"), "");
    fs.writeFileSync(
      w(workspacePath, ".yarnrc.yml"),
      "nodeLinker: node-modules\n",
    );
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toContainEqual({
      src: ".yarnrc.yml",
      dest: ".yarnrc.yml",
    });
    expect(config.steps.install.commands).toContainEqual({
      cmd: "yarn install",
    });
    expect(logger.lines.some((l) => l.includes("berry"))).toBe(true);
  });

  // --- Python / Poetry ---

  it("injects railpack.json for poetry projects", async () => {
    fs.writeFileSync(w(workspacePath, "pyproject.toml"), "[tool.poetry]");
    fs.writeFileSync(w(workspacePath, "poetry.lock"), "");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toEqual([
      { src: "pyproject.toml", dest: "pyproject.toml" },
      { src: "poetry.lock", dest: "poetry.lock" },
      { cmd: "poetry install --no-interaction" },
    ]);
    expect(logger.lines.some((l) => l.includes("poetry project"))).toBe(true);
  });

  it("does nothing for pyproject.toml without poetry.lock", async () => {
    fs.writeFileSync(w(workspacePath, "pyproject.toml"), "[build-system]");
    await prepareWorkspace({ workspacePath, logger: loggerStub() });
    expect(fs.existsSync(railpackJson(workspacePath))).toBe(false);
  });

  // --- Ruby / Bundler ---

  it("injects railpack.json for bundler projects", async () => {
    fs.writeFileSync(
      w(workspacePath, "Gemfile"),
      'source "https://rubygems.org"',
    );
    fs.writeFileSync(w(workspacePath, "Gemfile.lock"), "GEM\n  remote: https://rubygems.org/\n");
    const logger = loggerStub();
    await prepareWorkspace({ workspacePath, logger });

    const config = readConfig(workspacePath);
    expect(config.steps.install.commands).toEqual([
      { src: "Gemfile", dest: "Gemfile" },
      { src: "Gemfile.lock", dest: "Gemfile.lock" },
      { cmd: "bundle install" },
    ]);
    expect(logger.lines.some((l) => l.includes("bundler project"))).toBe(true);
  });

  it("does nothing for Gemfile without Gemfile.lock", async () => {
    fs.writeFileSync(
      w(workspacePath, "Gemfile"),
      'source "https://rubygems.org"',
    );
    await prepareWorkspace({ workspacePath, logger: loggerStub() });
    expect(fs.existsSync(railpackJson(workspacePath))).toBe(false);
  });
});
