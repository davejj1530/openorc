import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installRunner, LocalSandboxProvider, runnerFiles, type LocalSandbox, type RunnerInstall } from "@openorc/cloud";
import { git } from "@openorc/git";
import { dependencyInstall, installDependencies } from "./cloud-deps.js";

let directory: string;
let bin: string;
let sandbox: LocalSandbox;
let install: RunnerInstall;
let repo: string;

/** A package manager on the sandbox's PATH that takes `seconds` to install and exits with `code`. */
async function standIn(name: string, seconds: number, code = 0): Promise<void> {
  const script = `#!/bin/sh\nif [ "$1" = install ] || [ "$1" = ci ]; then sleep ${seconds}; mkdir -p node_modules; echo "$*" > node_modules/.installed; echo "installed by ${name}"; exit ${code}; fi\necho "${name} ran: $*"\n`;
  await writeFile(path.join(bin, name), script, { mode: 0o755 });
}

/** Runs `command` as the agent's processes do: the runner's own commands first on its PATH. */
async function asAgent(command: string) {
  const result = await sandbox.exec("sh", ["-c", command], { cwd: repo, env: { PATH: `${path.join(install.state, "bin")}:${bin}:/usr/bin:/bin` } });
  return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-deps-"));
  bin = path.join(directory, "bin");
  await mkdir(bin);
  sandbox = await new LocalSandboxProvider(path.join(directory, "sandboxes"), () => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin` })).open("workspace");
  install = await installRunner(sandbox, runnerFiles());
  repo = path.join(sandbox.root, "repo");
  await mkdir(repo);
});

afterEach(async () => {
  await sandbox.stop();
  await rm(directory, { recursive: true, force: true });
});

describe("a project's dependencies in its cloud sandbox", () => {
  it("are installed with the package manager its lockfile names, and the agent's package manager waits for them", async () => {
    await standIn("pnpm", 1);
    await installDependencies(install, repo, "pnpm install --frozen-lockfile", { NPM_TOKEN: "from the project" }, false);
    await expect(readFile(path.join(repo, "node_modules", ".installed"), "utf8")).rejects.toThrow();

    const ran = await asAgent("pnpm test --run");
    expect(ran.stdout).toBe("pnpm ran: test --run\n");
    expect(ran.stderr).toContain("Waiting for OpenOrc to finish installing this project's dependencies");
    expect(await readFile(path.join(repo, "node_modules", ".installed"), "utf8")).toBe("install --frozen-lockfile\n");
    expect(await readFile(path.join(install.state, "deps.log"), "utf8")).toBe("installed by pnpm\n");

    const again = await asAgent("pnpm test");
    expect(again).toMatchObject({ code: 0, stdout: "pnpm ran: test\n", stderr: "" });
  });

  it("let the agent's package manager run when the install failed, saying where its output is", async () => {
    await standIn("npm", 0, 1);
    expect(await installDependencies(install, repo, "npm ci --no-audit --no-fund", {}, true)).toBe(false);
    const ran = await asAgent("npm test");
    expect(ran.stdout).toBe("npm ran: test\n");
    expect(ran.stderr).toContain(`its output is in ${path.join(install.state, "deps.log")}`);
  });
});

describe("how a project installs its dependencies", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const root = path.join(directory, `project-${Object.keys(files).join("-")}`);
    await mkdir(root, { recursive: true });
    await git(root, ["init", "-q"]);
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
    await git(root, ["add", "-A"]);
    await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "files"]);
    return root;
  }

  it("follows the lockfile at the project's root, and is none without one", async () => {
    const at = async (files: Record<string, string>) => dependencyInstall(await project(files), "HEAD");
    expect(await at({ "package.json": "{}", "pnpm-lock.yaml": "" })).toBe("pnpm install --frozen-lockfile");
    expect(await at({ "package.json": '{ "packageManager": "yarn@4.5.0" }', "yarn.lock": "" })).toBe("yarn install --immutable");
    expect(await at({ "package.json": "{}", "yarn.lock": "" })).toBe("yarn install --frozen-lockfile");
    expect(await at({ "package.json": "{}", "package-lock.json": "{}" })).toBe("npm ci --no-audit --no-fund");
    expect(await at({ "package.json": "{}" })).toBeNull();
  });
});
