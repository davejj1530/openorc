import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { antigravityAuthenticated, agentBinary, slotFor } from "@openorc/agents";
import { executionModeAvailable, harnessCatalog } from "@openorc/protocol";
import { detectAgentInstallation } from "./agent-update-installation.js";
import { ANTIGRAVITY_LOCAL_ONLY } from "./cloud-agents.js";
import { pathProbe } from "./shell-environment.js";
import { harnessProbes } from "./system.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("checks login without prompting a model or opening an authentication flow", () => {
  expect(harnessProbes.antigravity.authArgs).toEqual(["models"]);
  expect(antigravityAuthenticated("Fetching available models...\nPlease sign in to view available models.")).toBe(false);
  expect(antigravityAuthenticated("gemini-3.8-flash   Gemini 3.8 Flash")).toBe(true);
  expect(antigravityAuthenticated("Network failure")).toBeNull();
  expect(antigravityAuthenticated("Please sign in", { GEMINI_API_KEY: "fixture-key" })).toBe(true);
  expect(antigravityAuthenticated("Please sign in", { GEMINI_API_KEY: " " })).toBe(false);
});

it("exposes native Plan and Autonomous while refusing cloud and session transfer", async () => {
  expect(executionModeAvailable("antigravity", "plan")).toBe(true);
  expect(executionModeAvailable("antigravity", "autonomous")).toBe(true);
  expect(executionModeAvailable("antigravity", "review")).toBe(false);
  expect(executionModeAvailable("antigravity", "trusted")).toBe(false);
  expect(harnessCatalog.antigravity.cloud).toBe(false);
  expect(slotFor("antigravity")?.stays).toContain("stay on the computer");
  await expect(ANTIGRAVITY_LOCAL_ONLY.assertCanRun("vercel", { claudeAccountId: null, model: null })).rejects.toThrow("connected computer");
});

it("discovers agy separately from the IDE and updates its native installation", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-agy-install-")));
  dirs.push(home);
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  const binary = path.join(bin, "agy");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const found = await pathProbe({ PATH: bin })("/bin/sh");
  expect(found.binaries.antigravity).toBe(binary);
  vi.stubEnv("OPENORC_ANTIGRAVITY_BIN", "");
  expect(agentBinary("antigravity")).toBe("agy");
  const installed = await detectAgentInstallation("antigravity", binary, { revision: 1, shell: "/bin/sh", path: bin, binaries: found.binaries, env: { HOME: home } });
  expect(installed).toMatchObject({ method: "Native", command: { binary, args: ["update"] }, repair: null });
  expect(installed.releaseUrl).toContain("/manifests/");
  expect(installed.releaseUrl).not.toContain("npmjs");
});
