import { beforeEach, describe, expect, it } from "vitest";
import { acceptShellEnv, listenForShellEnv, loginShellEnv, resetShellEnvForTests, shellEnvFromMessage, type CoreMessages } from "./shell-env";

const message = (revision: number, path: string, claude: string | null = null) => ({ type: "shell-env", snapshot: { revision, shell: "/bin/zsh", path, binaries: { claude, codex: null } } });

/** Stands in for a UtilityProcess: delivers whatever main posts, as the raw payload Electron hands the listener. */
function fakeCore(): CoreMessages & { post(payload: unknown): void } {
  const listeners: Array<(payload: unknown) => void> = [];
  return {
    on: (_event, listener) => listeners.push(listener),
    post: (payload) => listeners.forEach((l) => l(payload)),
  };
}

describe("shell env from the core", () => {
  beforeEach(() => resetShellEnvForTests());

  it("ignores messages that are not a snapshot or carry no revision", () => {
    expect(shellEnvFromMessage({ type: "shutdown" })).toBeNull();
    expect(shellEnvFromMessage({ type: "shell-env", snapshot: { binaries: {} } })).toBeNull();
    expect(shellEnvFromMessage({ type: "shell-env", snapshot: { path: "/usr/bin", binaries: {} } })).toBeNull();
    expect(shellEnvFromMessage("noise")).toBeNull();
  });

  it("reaches the store through the raw payload a utility process delivers", async () => {
    const core = fakeCore();
    listenForShellEnv(core);
    core.post({ type: "log", level: "info", message: "ignored" });
    core.post(message(1, "/opt/homebrew/bin:/usr/bin", "/opt/homebrew/bin/claude"));
    expect(await loginShellEnv()).toEqual({ path: "/opt/homebrew/bin:/usr/bin", claude: "/opt/homebrew/bin/claude", codex: null });
  });

  it("rejects a duplicate or older revision from the same core", () => {
    const core = fakeCore();
    listenForShellEnv(core);
    core.post(message(2, "/second/bin:/usr/bin"));
    expect(acceptShellEnv(1, { revision: 2, env: { path: "/dup", claude: null, codex: null } })).toBe(false);
    expect(acceptShellEnv(1, { revision: 1, env: { path: "/older", claude: null, codex: null } })).toBe(false);
    core.post(message(3, "/third/bin:/usr/bin"));
    return expect(loginShellEnv()).resolves.toEqual({ path: "/third/bin:/usr/bin", claude: null, codex: null });
  });

  it("accepts revision 1 from a restarted core and ignores what the old core says afterwards", async () => {
    const first = fakeCore();
    const second = fakeCore();
    listenForShellEnv(first);
    first.post(message(5, "/old/bin:/usr/bin"));
    listenForShellEnv(second);
    second.post(message(1, "/new/bin:/usr/bin"));
    first.post(message(6, "/late/bin:/usr/bin"));
    expect(await loginShellEnv()).toEqual({ path: "/new/bin:/usr/bin", claude: null, codex: null });
  });

  it("makes a panel opened before the core's first answer wait for it", async () => {
    const pending = loginShellEnv();
    acceptShellEnv(1, { revision: 1, env: { path: "/opt/homebrew/bin:/usr/bin", claude: null, codex: null } });
    expect(await pending).toEqual({ path: "/opt/homebrew/bin:/usr/bin", claude: null, codex: null });
  });

  it("gives up on a core that never answers, so the user still gets a terminal", async () => {
    expect(await loginShellEnv(5)).toBeNull();
  });
});
