import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { fxAuthenticated, slotFor } from "@openorc/agents";
import { executionModeAvailable, executionModePresentation, harnessCatalog } from "@openorc/protocol";
import { detectAgentInstallation, fetchAgentRelease } from "./agent-update-installation.js";
import { LOCAL_ONLY_SIGN_INS } from "./cloud-agents.js";
import { pathProbe } from "./shell-environment.js";
import { harnessProbes } from "./system.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("recognizes cached login, API keys and unauthenticated local providers without inference", () => {
  expect(harnessProbes.fx.authArgs).toEqual(["status", "--json"]);
  for (const auth of ["fx login", "AI_GATEWAY_API_KEY", "Codex subscription", "configured provider", "stored API key (Keychain)"])
    expect(fxAuthenticated(JSON.stringify({ kind: "status", auth }))).toBe(true);
  expect(fxAuthenticated('{"kind":"status","auth":"missing"}')).toBe(false);
  expect(fxAuthenticated('{"kind":"status","auth":"future source"}')).toBeNull();
  expect(fxAuthenticated("request failed")).toBeNull();
});

it("exposes native permission modes and keeps unsupported planning and cloud actions unavailable", async () => {
  expect(executionModeAvailable("fx", "plan")).toBe(false);
  expect(executionModePresentation("fx", "review").label).toBe("Ask");
  expect(executionModePresentation("fx", "trusted").label).toBe("Auto review");
  expect(executionModeAvailable("fx", "autonomous")).toBe(true);
  expect(harnessCatalog.fx.cloud).toBe(false);
  expect(slotFor("fx")?.stays).toContain("stay on the computer");
  await expect(LOCAL_ONLY_SIGN_INS.fx.assertCanRun("vercel", { claudeAccountId: null, model: null })).rejects.toThrow("connected computer");
});

it("discovers the native binary and updates it from fx's release service", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-fx-install-")));
  dirs.push(home);
  const bin = path.join(home, ".local/bin");
  await mkdir(bin, { recursive: true });
  const binary = path.join(bin, "fx");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const found = await pathProbe({ PATH: bin })("/bin/sh");
  expect(found.binaries.fx).toBe(binary);
  const installed = await detectAgentInstallation("fx", binary, { revision: 1, shell: "/bin/sh", path: bin, binaries: found.binaries, env: { HOME: home } });
  expect(installed).toMatchObject({ method: "Native", command: { binary, args: ["upgrade"] }, repair: null, releaseUrl: "https://releases.fx.sh/latest.txt" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("v0.0.16\n")),
  );
  expect(await fetchAgentRelease(installed.releaseUrl)).toBe("0.0.16");
  await mkdir(path.join(home, ".fx"));
  await writeFile(path.join(home, ".fx/settings.json"), JSON.stringify({ update_channel: "dev" }));
  const development = await detectAgentInstallation("fx", binary, { revision: 1, shell: "/bin/sh", path: bin, binaries: found.binaries, env: { HOME: home } });
  expect(development.command).toBeNull();
  expect(development.message).toContain("development release");
});
