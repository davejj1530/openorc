import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessIds, type HarnessId, type SystemInfo } from "@openorc/protocol";
import { AgentUpdateService } from "./agent-updates.js";
import { fetchAgentRelease, newerRelease, releaseVersion, type AgentInstallation } from "./agent-update-installation.js";
import type { EnvSnapshot } from "./shell-environment.js";

const environment: EnvSnapshot = { revision: 1, shell: "/bin/zsh", path: "/fixture", binaries: { codex: "/fixture/codex", claude: "/fixture/claude", opencode: null }, env: { PATH: "/fixture" } };
function setup() {
  const versions: Record<HarnessId, string | null> = { codex: "codex-cli 1.0.0", claude: "2.1.0 (Claude Code)", opencode: null };
  /** Installed agents whose version command fails. */
  const failing = new Set<HarnessId>();
  const info = vi.fn(async (): Promise<SystemInfo> => ({
    dataDir: "/fixture",
    gh: { installed: false, path: null },
    harnesses: harnessIds.map((id) =>
      failing.has(id)
        ? { id, state: "check_failed", path: `/fixture/${id}`, version: null, revision: 1 }
        : { id, state: versions[id] ? "ready" : "not_found", path: versions[id] ? `/fixture/${id}` : null, version: versions[id], revision: 1 },
    ),
  }));
  const detect = vi.fn(async (id: HarnessId): Promise<AgentInstallation> => ({
    method: "npm",
    identity: `/fixture/${id}`,
    releaseUrl: id,
    command: { binary: "/fixture/npm", args: [id] },
    repair: { binary: "/fixture/npm", args: [id, "repair"] },
    message: null,
  }));
  const latest = vi.fn(async (id: string) => (id === "codex" ? "1.1.0" : "2.2.0"));
  const run = vi.fn(async (command: { binary: string; args: string[] }) => {
    const id = command.args[0] as HarnessId;
    versions[id] = await latest(id);
    failing.delete(id);
    return "";
  });
  const release = vi.fn();
  const reserve = vi.fn(async () => release);
  const saved = new Map<string, string>();
  const changed = vi.fn();
  const service = new AgentUpdateService({
    info,
    environment: () => environment,
    detect,
    latest,
    run,
    reserve,
    changed,
    read: (key) => saved.get(key) ?? null,
    write: (key, value) => {
      saved.set(key, value);
    },
  });
  return { service, info, detect, latest, run, reserve, release, versions, failing, saved };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("agent release checks", () => {
  it("coalesces concurrent checks, skips missing agents, and never installs during a check", async () => {
    const f = setup();
    const a = f.service.check(),
      b = f.service.check();
    expect(a).toBe(b);
    const state = await a;
    expect(f.info).toHaveBeenCalledTimes(1);
    expect(f.latest).toHaveBeenCalledTimes(2);
    expect(state.checking).toBe(false);
    expect(state.agents.map((row) => row.status)).toEqual(["available", "available", "not_installed"]);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps offline failures separate from up-to-date results", async () => {
    const f = setup();
    f.latest.mockRejectedValueOnce(new Error("offline"));
    const state = await f.service.check();
    expect(state.agents[0]).toMatchObject({ status: "error", installedVersion: "1.0.0", latestVersion: null });
    expect(state.agents[1]?.status).toBe("available");
  });
  it("honors automatic-check preference and cleans up timers", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.service.configure({ automatic: false, dismissed: "codex:1.1.0" });
    f.service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.info).not.toHaveBeenCalled();
    f.service.configure({ automatic: true });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(f.info).toHaveBeenCalledTimes(1);
    expect(f.service.get().dismissed).toBe("codex:1.1.0");
    await f.service.close();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(f.info).toHaveBeenCalledTimes(1);
  });
  it("strictly parses stable versions and compares numerically", () => {
    expect(releaseVersion("codex-cli 0.100.0")).toBe("0.100.0");
    expect(releaseVersion("2.1.0 (Claude Code)")).toBe("2.1.0");
    for (const invalid of ["1.2.3-beta.1", "1.2.3+build", "dev", "1.2.3456evil"]) expect(releaseVersion(invalid)).toBeNull();
    expect(newerRelease("0.100.0", "0.99.0")).toBe(true);
    expect(newerRelease("1.1.1", "2.0.0")).toBe(false);
  });
  it("validates release metadata and rejects failed HTTP responses", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    fetch.mockResolvedValueOnce(new Response('{"version":"1.2.3"}'));
    expect(await fetchAgentRelease("https://registry.npmjs.org/@openai/codex/latest")).toBe("1.2.3");
    fetch.mockResolvedValueOnce(new Response('{"version":"1.2.3; echo bad"}'));
    await expect(fetchAgentRelease("fixture")).rejects.toThrow("unrecognized");
    fetch.mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(fetchAgentRelease("fixture")).rejects.toThrow("could not be reached");
  });
});

describe("agent updates", () => {
  it("refuses active work without executing or changing available releases", async () => {
    const f = setup();
    await f.service.check();
    f.reserve.mockRejectedValueOnce(new Error("Finish agent work"));
    await expect(f.service.install(["codex"])).rejects.toThrow("Finish agent work");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.service.get()).toMatchObject({ updating: false, agents: [expect.objectContaining({ status: "available" }), expect.anything(), expect.anything()] });
  });
  it("updates sequentially, verifies versions, and releases admission even when one agent fails", async () => {
    const f = setup();
    await f.service.check();
    f.run.mockRejectedValueOnce(new Error("Fixture update failed"));
    const state = await f.service.install(["codex", "claude", "claude"]);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(state.agents[0]).toMatchObject({ status: "error", message: "Fixture update failed" });
    expect(state.agents[1]).toMatchObject({ status: "current", installedVersion: "2.2.0" });
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(state.updating).toBe(false);
  });
  it("does not report success just because a command exited successfully", async () => {
    const f = setup();
    await f.service.check();
    f.run.mockResolvedValueOnce("");
    const state = await f.service.install(["codex"]);
    expect(state.agents[0]).toMatchObject({ status: "error", message: expect.stringContaining("not active yet") });
  });
  it("refuses an installation replaced after the check", async () => {
    const f = setup();
    await f.service.check();
    f.detect.mockResolvedValueOnce({ identity: "/other/codex", method: "Manual", releaseUrl: "codex", command: null, repair: null, message: null });
    expect((await f.service.install(["codex"])).agents[0]?.message).toContain("installation changed");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalled();
  });
  it("rejects manual installs and serializes competing install requests", async () => {
    const f = setup();
    await f.service.check();
    await expect(f.service.install(["opencode"])).rejects.toThrow("Check for updates");
    const first = f.service.install(["codex"]);
    await expect(f.service.install(["claude"])).rejects.toThrow("already running");
    await first;
  });
});

describe("installations that fail to start", () => {
  it("offers a reinstall instead of a release check, then trusts only the next version probe", async () => {
    const f = setup();
    f.failing.add("codex");
    const state = await f.service.check();
    expect(state.agents[0]).toMatchObject({ status: "broken", installedVersion: null, method: "npm", canUpdate: true, message: null });
    expect(f.latest).toHaveBeenCalledTimes(1);
    const after = await f.service.install(["codex"]);
    expect(f.run).toHaveBeenCalledWith({ binary: "/fixture/npm", args: ["codex", "repair"] }, expect.anything());
    expect(after.agents[0]).toMatchObject({ status: "unchecked", installedVersion: "1.1.0", canUpdate: false, message: "Reinstalled." });
  });
  it("says when an update leaves the agent unable to start and offers the reinstall", async () => {
    const f = setup();
    await f.service.check();
    f.run.mockImplementationOnce(async () => {
      f.failing.add("codex");
      return "";
    });
    const state = await f.service.install(["codex"]);
    expect(state.agents[0]).toMatchObject({ status: "broken", installedVersion: null, canUpdate: true, message: "Codex no longer starts after the update." });
  });
  it("reports a reinstall that did not help", async () => {
    const f = setup();
    f.failing.add("codex");
    await f.service.check();
    f.run.mockResolvedValueOnce("");
    expect((await f.service.install(["codex"])).agents[0]).toMatchObject({ status: "error", message: expect.stringContaining("Reinstalling did not fix it") });
  });
  it("leaves the reinstall to the user when the broken binary is its own updater", async () => {
    const f = setup();
    f.failing.add("claude");
    f.detect.mockImplementation(async (id) => ({ method: "Native", identity: `/fixture/${id}`, releaseUrl: id, command: { binary: `/fixture/${id}`, args: ["update"] }, repair: null, message: null }));
    const state = await f.service.check();
    expect(state.agents[1]).toMatchObject({ status: "broken", canUpdate: false, message: expect.stringContaining("Reinstall using the tool") });
    await expect(f.service.install(["claude"])).rejects.toThrow("Check for updates");
    expect(f.run).not.toHaveBeenCalled();
  });
});
