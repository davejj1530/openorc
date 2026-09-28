import { describe, expect, it, vi } from "vitest";
import type { EnvSnapshot, RefreshResult } from "./shell-environment.js";
import { SystemService, type CommandProbe } from "./system.js";

function snapshot(revision = 3): EnvSnapshot {
  const env = {
    PATH: "/harness/bin:/usr/bin",
    OPENORC_CLAUDE_BIN: "/harness/bin/claude",
  };
  return {
    revision,
    shell: "/bin/zsh",
    path: env.PATH,
    binaries: { codex: null, claude: env.OPENORC_CLAUDE_BIN, opencode: null },
    env: Object.freeze(env),
  };
}

function environment(current: EnvSnapshot, refresh: RefreshResult = { ok: true, snapshot: current }) {
  return { current: vi.fn(() => current), refresh: vi.fn(async () => refresh) };
}

describe("SystemService harness registry", () => {
  it("shares recent probes across callers, then rechecks after a minute or an environment change", async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const env = environment(snapshot());
      const command = vi.fn<CommandProbe>(async (_binary, args) => ({ status: "ok", output: args[0] === "--version" ? "2.1.0" : '{"loggedIn":true}' }));
      const service = new SystemService("/data", env, command);
      await Promise.all(Array.from({ length: 5 }, () => service.info()));
      expect(command).toHaveBeenCalledTimes(2);
      now += 59_999;
      await service.info();
      expect(command).toHaveBeenCalledTimes(2);
      now += 1;
      await Promise.all([service.info(), service.info()]);
      expect(command).toHaveBeenCalledTimes(4);
      env.current.mockReturnValue(snapshot(4));
      await service.info();
      expect(command).toHaveBeenCalledTimes(6);
    } finally {
      clock.mockRestore();
    }
  });

  it("reports a refresh failure without replacing the last accepted harnesses with not found", async () => {
    const admitted = snapshot();
    const env = environment(admitted);
    const implementation: CommandProbe = async (_binary, args) => (args[0] === "--version" ? { status: "ok", output: "2.1.0" } : { status: "ok", output: '{"loggedIn":true}' });
    const command = vi.fn(implementation);
    const service = new SystemService("/data", env, command);
    await service.info();
    env.refresh.mockResolvedValueOnce({ ok: false, error: "shell timed out", snapshot: admitted });

    const failed = await service.info(true);

    expect(failed.harnesses[0]).toMatchObject({ id: "codex", state: "check_failed", revision: 3 });
    expect(failed.harnesses[1]).toEqual({ id: "claude", state: "check_failed", path: "/harness/bin/claude", version: "2.1.0", revision: 3 });
    expect(env.current()).toBe(admitted);
  });
});
