import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { agentBinary, releaseOf, slotFor } from "@openorc/agents";
import { executionModeAvailable, harnessCatalog } from "@openorc/protocol";
import { detectAgentInstallation, fetchAgentRelease, newerRelease, releaseVersion } from "./agent-update-installation.js";
import { CURSOR_LOCAL_ONLY } from "./cloud-agents.js";
import { pathProbe, type EnvSnapshot } from "./shell-environment.js";
import { harnessProbes } from "./system.js";
import { everyVersion } from "./agent-homes.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("finds cursor-agent without confusing it with the editor's cursor command", async () => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "openorc-cursor-bin-"));
  dirs.push(bin);
  for (const name of ["cursor", "cursor-agent"]) await writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const found = await pathProbe({ PATH: bin })("/bin/sh");
  expect(found.binaries.cursor).toBe(path.join(bin, "cursor-agent"));
  vi.stubEnv("OPENORC_CURSOR_BIN", "");
  expect(agentBinary("cursor")).toBe("cursor-agent");
  vi.stubEnv("OPENORC_CURSOR_BIN", "/custom/agent");
  expect(agentBinary("cursor")).toBe("/custom/agent");
});

it("checks Cursor's structured login status and exposes only its supported execution modes", () => {
  expect(harnessProbes.cursor.authArgs).toEqual(["status", "--format", "json"]);
  expect(harnessProbes.cursor.authenticated('{"isAuthenticated":true}')).toBe(true);
  expect(harnessProbes.cursor.authenticated('{"isAuthenticated":false,"hasAccessToken":true}')).toBe(false);
  expect(executionModeAvailable("cursor", "plan")).toBe(true);
  expect(executionModeAvailable("cursor", "autonomous")).toBe(true);
  expect(executionModeAvailable("cursor", "review")).toBe(false);
  expect(executionModeAvailable("cursor", "trusted")).toBe(false);
});

it("refuses cloud use before any credentials or sessions can be copied", async () => {
  expect(harnessCatalog.cursor.cloud).toBe(false);
  expect(slotFor("cursor")?.stays).toContain("stay on the computer");
  await expect(CURSOR_LOCAL_ONLY.assertCanRun("vercel", { claudeAccountId: null, model: "auto" })).rejects.toThrow("connected computer");
  const version = vi.fn(async () => "1.0.0");
  expect((await everyVersion(version)).cursor).toBeNull();
  expect(version).not.toHaveBeenCalledWith("cursor");
});

it("uses Cursor's native updater and preserves its date and build hash", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cursor-home-")));
  dirs.push(home);
  const version = "2026.11.05-86047df";
  const target = path.join(home, ".local/share/cursor-agent/versions", version, "cursor-agent");
  const binary = path.join(home, ".local/bin/cursor-agent");
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
  await symlink(target, binary);
  const snapshot: EnvSnapshot = {
    revision: 1,
    shell: "/bin/sh",
    path: path.dirname(binary),
    binaries: { codex: null, claude: null, opencode: null, omp: null, cursor: binary, pi: null, antigravity: null, fx: null },
    env: { HOME: home },
  };
  expect(await detectAgentInstallation("cursor", binary, snapshot)).toMatchObject({ method: "Native", releaseUrl: "https://cursor.com/install", command: { binary, args: ["update"] }, repair: null });
  expect(releaseVersion(version)).toBe(version);
  expect(releaseOf(version)).toBe(version);
  expect(newerRelease(version, "2026.11.04-abcdef0")).toBe(true);
  expect(newerRelease(version, version)).toBe(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(`DOWNLOAD_URL="https://downloads.cursor.com/lab/${version}/darwin/arm64/agent-cli-package.tar.gz"`)),
  );
  await expect(fetchAgentRelease("https://cursor.com/install")).resolves.toBe(version);
});
