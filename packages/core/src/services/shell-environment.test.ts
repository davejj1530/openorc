import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellEnvironment, loginShell, parseShellProbe, type ShellProbe, type ShellProbeResult } from "./shell-environment.js";

afterEach(() => vi.restoreAllMocks());

const answer = (path: string, claude: string | null = null, codex: string | null = null): ShellProbeResult => ({ path, binaries: { claude, codex, opencode: null } });

/** A probe whose answers resolve when the test says so, in the order the test says. */
function controlledProbe() {
  const pending: Array<{ resolve: (r: ShellProbeResult) => void; reject: (e: Error) => void }> = [];
  const probe: ShellProbe = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return { probe, pending };
}

describe("parseShellProbe", () => {
  it("reads the probe even when the profile prints first", () => {
    const stdout = [
      "Welcome back, Alex",
      "nvm: lazy loading",
      "",
      "@@openorc@@path=/Users/d/.local/bin:/opt/homebrew/bin:/usr/bin",
      "@@openorc@@claude=/Users/d/.local/bin/claude",
      "@@openorc@@codex=",
      "",
    ].join("\n");
    expect(parseShellProbe(stdout)).toEqual({ path: "/Users/d/.local/bin:/opt/homebrew/bin:/usr/bin", binaries: { claude: "/Users/d/.local/bin/claude", codex: null, opencode: null } });
  });

  it("gives up without a path rather than guessing", () => {
    expect(parseShellProbe("just noise\n")).toBeNull();
  });
});

describe("loginShell", () => {
  it("uses the inherited shell when account lookup is empty or fails", () => {
    const account = os.userInfo();
    const lookup = vi.spyOn(os, "userInfo");
    lookup.mockReturnValueOnce({ ...account, shell: "" });
    expect(loginShell({ SHELL: "/bin/bash" })).toBe("/bin/bash");
    lookup.mockImplementationOnce(() => {
      throw new Error("account unavailable");
    });
    expect(loginShell({ SHELL: "/bin/ksh" })).toBe("/bin/ksh");
  });

  it("uses the platform fallback when neither account nor inherited shell is available", () => {
    const account = os.userInfo();
    vi.spyOn(os, "userInfo").mockReturnValue({ ...account, shell: "" });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(loginShell({})).toBe("/bin/zsh");
    platform.mockReturnValue("linux");
    expect(loginShell({})).toBe("/bin/sh");
  });
});

describe("ShellEnvironment", () => {
  it("carries a frozen copy of the whole environment that agrees with its own fields", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/Users/d", OPENORC_CODEX_BIN: "/stale/codex" };
    const shellEnv = new ShellEnvironment({ env, probe: async () => answer("/opt/homebrew/bin:/usr/bin", "/opt/homebrew/bin/claude"), shell: () => "/bin/zsh" });
    await shellEnv.refresh();
    const snapshot = shellEnv.current();
    expect(snapshot.env).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/d", OPENORC_CLAUDE_BIN: "/opt/homebrew/bin/claude" });
    expect(snapshot.env["PATH"]).toBe(snapshot.path);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.env)).toBe(true);
    expect(Object.isFrozen(snapshot.binaries)).toBe(true);
  });

  it("keeps an admitted snapshot unchanged when process.env, the probe's result, or the next refresh move on", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const probed = answer("/opt/homebrew/bin:/usr/bin", "/opt/homebrew/bin/claude");
    let calls = 0;
    const probe: ShellProbe = async () => (calls++ === 0 ? probed : answer("/other/bin:/usr/bin"));
    const shellEnv = new ShellEnvironment({ env, probe, shell: () => "/bin/zsh" });
    await shellEnv.refresh();
    const admitted = shellEnv.current();
    env["PATH"] = "/mutated";
    env["OPENORC_CLAUDE_BIN"] = "/mutated/claude";
    probed.binaries.claude = "/mutated/probe";
    await shellEnv.refresh();
    expect(admitted.path).toBe("/opt/homebrew/bin:/usr/bin");
    expect(admitted.env["PATH"]).toBe("/opt/homebrew/bin:/usr/bin");
    expect(admitted.binaries.claude).toBe("/opt/homebrew/bin/claude");
    expect(shellEnv.current().revision).toBe(2);
  });

  it("still accepts a refresh when a listener throws, because the notification is best effort", async () => {
    const shellEnv = new ShellEnvironment({ env: { PATH: "/usr/bin" }, probe: async () => answer("/opt/homebrew/bin:/usr/bin"), shell: () => "/bin/zsh" });
    const reached: number[] = [];
    shellEnv.onChange(() => {
      throw new Error("main is gone");
    });
    shellEnv.onChange((s) => reached.push(s.revision));
    const result = await shellEnv.refresh();
    expect(result.ok).toBe(true);
    expect(shellEnv.current().revision).toBe(1);
    expect(reached).toEqual([1]);
  });

  it("keeps the last good snapshot when a probe fails, and reports the failure", async () => {
    let calls = 0;
    const probe: ShellProbe = async () => {
      calls += 1;
      if (calls === 1) return answer("/opt/homebrew/bin:/usr/bin", "/opt/homebrew/bin/claude");
      throw new Error("timed out");
    };
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const shellEnv = new ShellEnvironment({ env, probe, shell: () => "/bin/zsh" });
    await shellEnv.refresh();
    const good = shellEnv.current();
    const result = await shellEnv.refresh();
    expect(result).toEqual({ ok: false, error: "timed out", snapshot: good });
    expect(shellEnv.current()).toBe(good);
    expect(env["OPENORC_CLAUDE_BIN"]).toBe("/opt/homebrew/bin/claude");
  });

  it("merges from the launcher's PATH every time, never from a previous merge", async () => {
    let calls = 0;
    const probe: ShellProbe = async () => (calls++ === 0 ? answer("/first/bin:/usr/bin") : answer("/second/bin:/usr/bin"));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/launcher/bin" };
    const shellEnv = new ShellEnvironment({ env, probe, shell: () => "/bin/zsh" });
    await shellEnv.refresh();
    await shellEnv.refresh();
    expect(env["PATH"]).toBe("/second/bin:/usr/bin:/launcher/bin");
  });

  it("coalesces overlapping refreshes into one probe, so revisions stay monotonic", async () => {
    const { probe, pending } = controlledProbe();
    const shellEnv = new ShellEnvironment({ env: { PATH: "/usr/bin" }, probe, shell: () => "/bin/zsh" });
    const first = shellEnv.refresh();
    const second = shellEnv.refresh();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(answer("/opt/homebrew/bin:/usr/bin"));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(shellEnv.current().revision).toBe(1);
    // A refresh asked for after the first settled is a new probe.
    const third = shellEnv.refresh();
    expect(pending).toHaveLength(2);
    pending[1]!.resolve(answer("/opt/homebrew/bin:/usr/bin"));
    await third;
    expect(shellEnv.current().revision).toBe(2);
  });
});
