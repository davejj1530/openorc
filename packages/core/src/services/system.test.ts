import { describe, expect, it, vi } from "vitest";
import type { SystemInfo } from "@openorc/protocol";
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
    binaries: { codex: null, claude: env.OPENORC_CLAUDE_BIN, opencode: null, omp: null, cursor: null, pi: null, antigravity: null, fx: null },
    env: Object.freeze(env),
  };
}

function environment(current: EnvSnapshot, refresh: RefreshResult = { ok: true, snapshot: current }) {
  return { current: vi.fn(() => current), refresh: vi.fn(async () => refresh) };
}

describe("SystemService gh", () => {
  it("answers whether gh is installed, asking it at most once every 30 s", async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let installed = true;
      const gh = vi.fn(async () => installed);
      const service = new SystemService("/data", environment(snapshot()), { gh });
      expect(await Promise.all([service.gh(), service.gh()])).toEqual([{ installed: true }, { installed: true }]);
      expect(gh).toHaveBeenCalledTimes(1);
      installed = false;
      now += 29_999;
      expect(await service.gh()).toEqual({ installed: true });
      now += 1;
      expect(await service.gh()).toEqual({ installed: false });
      expect(gh).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("SystemService harness registry", () => {
  it("shares recent probes across callers, then rechecks after a minute or an environment change", async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const env = environment(snapshot());
      const command = vi.fn<CommandProbe>(async (_binary, args) => ({ status: "ok", output: args[0] === "--version" ? "2.1.0" : '{"loggedIn":true}' }));
      const service = new SystemService("/data", env, { command });
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
    const service = new SystemService("/data", env, { command });
    await service.info();
    env.refresh.mockResolvedValueOnce({ ok: false, error: "shell timed out", snapshot: admitted });

    const failed = await service.info(true);

    expect(failed.harnesses[0]).toMatchObject({ id: "codex", state: "check_failed", revision: 3 });
    expect(failed.harnesses[1]).toEqual({ id: "claude", state: "check_failed", path: "/harness/bin/claude", version: "2.1.0", revision: 3 });
    expect(env.current()).toBe(admitted);
  });
});

it("keeps readiness and concurrent probes separate for three accounts", async () => {
  const base = snapshot();
  const command = vi.fn<CommandProbe>(async (_binary, args, env) => ({
    status: "ok",
    output: args[0] === "--version" ? "fixture" : JSON.stringify({ loggedIn: env.CLAUDE_CONFIG_DIR !== "signed-out" }),
  }));
  const service = new SystemService("/data", environment(base), { command });
  const accounts = ["work", "personal", "signed-out"].map((id) => ({ ...base, scope: id, env: { ...base.env, CLAUDE_CONFIG_DIR: id } }));
  const reports = await Promise.all(accounts.map((entry) => service.infoFor(entry)));
  expect(reports.map((report) => report.harnesses.find((row) => row.id === "claude")?.state)).toEqual(["ready", "ready", "sign_in"]);
  expect(command).toHaveBeenCalledTimes(6);
  await Promise.all(accounts.map((entry) => service.infoFor(entry)));
  expect(command).toHaveBeenCalledTimes(6);
});

describe("SystemService shown checks", () => {
  const loggedIn = (answer: () => boolean) => vi.fn<CommandProbe>(async (_binary, args) => ({ status: "ok", output: args[0] === "--version" ? "2.1.0" : JSON.stringify({ loggedIn: answer() }) }));
  const claude = (info: SystemInfo) => info.harnesses.find((row) => row.id === "claude");
  function keptRows() {
    const rows = new Map<string, SystemInfo>();
    return { rows, kept: { read: (name: string) => rows.get(name), write: (name: string, info: SystemInfo) => void rows.set(name, info) } };
  }

  it("answers with the last checks at once, runs them again behind it and says when they changed", async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let signedIn = true;
      const command = loggedIn(() => signedIn);
      const changed = vi.fn();
      const service = new SystemService("/data", environment(snapshot()), { command, changed });
      expect(claude(await service.shown(snapshot()))?.state).toBe("ready");
      now += 60_000;
      signedIn = false;
      expect(claude(await service.shown(snapshot()))?.state).toBe("ready");
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
      expect(claude(await service.shown(snapshot()))?.state).toBe("sign_in");
      // A later environment is answered from the last one too, stamped as its own.
      const later = await service.shown(snapshot(4));
      expect(claude(later)).toMatchObject({ state: "sign_in", revision: 4 });
      await service.infoFor(snapshot(4));
      expect(command).toHaveBeenCalledTimes(6);
      expect(changed).toHaveBeenCalledTimes(1);
      // Whoever launches from the checks waits for current ones.
      now += 60_000;
      signedIn = true;
      expect(claude(await service.infoFor(snapshot(4)))?.state).toBe("ready");
    } finally {
      clock.mockRestore();
    }
  });

  it("answers a new start with the checks kept from the last one, unless a binary moved", async () => {
    const { rows, kept } = keptRows();
    await new SystemService("/elsewhere", environment(snapshot()), { command: loggedIn(() => true), kept }).shown(snapshot());
    expect(claude(rows.get("")!)?.state).toBe("ready");

    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => (finish = resolve));
    const command = vi.fn<CommandProbe>(async (_binary, args) => {
      await waiting;
      return { status: "ok", output: args[0] === "--version" ? "2.1.0" : '{"loggedIn":true}' };
    });
    const service = new SystemService("/data", environment(snapshot(1)), { command, kept });
    const early = await service.shown(snapshot(1));
    expect(early.dataDir).toBe("/data");
    expect(claude(early)).toMatchObject({ state: "ready", revision: 1 });

    const moved = { ...snapshot(1), scope: "", binaries: { ...snapshot().binaries, claude: "/other/claude" } };
    let answered = false;
    const checked = service.shown({ ...moved, revision: 2 }).then((info) => {
      answered = true;
      return info;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    finish();
    expect(claude(await checked)?.path).toBe("/other/claude");
  });
});
