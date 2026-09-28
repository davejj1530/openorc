import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_SETTLE_MS } from "../shared/command-settle";
import { PtyHost, Scrollback, clampSize, ptyEnv, terminalShell, validateCwd, type PtyProcess, type SpawnPty } from "./pty-host";

/** A shell that never existed. Every test here asserts on the host's bookkeeping, which is the half that has to be right before a real one is worth spawning. */
class FakePty implements PtyProcess {
  readonly written: string[] = [];
  readonly sizes: { cols: number; rows: number }[] = [];
  killed = false;
  private data: ((chunk: string) => void) | null = null;
  private exit: ((event: { exitCode: number }) => void) | null = null;

  onData(cb: (data: string) => void): { dispose(): void } {
    this.data = cb;
    return {
      dispose: () => {
        this.data = null;
      },
    };
  }
  onExit(cb: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exit = cb;
    return {
      dispose: () => {
        this.exit = null;
      },
    };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }

  /** Whether the host is still holding this shell's handlers, which is what a shell that ignores SIGHUP keeps alive. */
  get listening(): boolean {
    return this.data !== null || this.exit !== null;
  }
  say(chunk: string): void {
    this.data?.(chunk);
  }
  finish(exitCode: number): void {
    this.exit?.({ exitCode });
  }
}

function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "openorc-pty-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scrollback ring", () => {
  it("keeps everything that fits", () => {
    const ring = new Scrollback(64);
    ring.push("hello ");
    ring.push("world");
    expect(ring.read()).toBe("hello world");
    expect(ring.byteLength).toBe(11);
  });

  it("drops from the front and says so, so a command that never stops cannot grow memory", () => {
    const ring = new Scrollback(10);
    for (let i = 0; i < 1000; i += 1) ring.push("yes\n");
    expect(ring.byteLength).toBeLessThanOrEqual(10);
    expect(ring.read().endsWith("yes\n")).toBe(true);
    // The reset in front is the tell that the head was cut.
    expect(ring.read().startsWith(String.fromCharCode(27))).toBe(true);
  });

  it("cuts a multibyte chunk on a codepoint boundary", () => {
    const ring = new Scrollback(7);
    // Three bytes each, so a naive tail would land inside the second one.
    ring.push("éééé".repeat(2));
    expect(ring.byteLength).toBeLessThanOrEqual(7);
    expect(ring.read()).not.toContain("�");
  });

  it("ignores empty writes", () => {
    const ring = new Scrollback(16);
    ring.push("");
    expect(ring.read()).toBe("");
  });
});

describe("cwd validation", () => {
  it("accepts a real directory", () => {
    expect(validateCwd(dir)).toBe(dir);
  });

  it("refuses a relative path, a missing one, a file and an empty string", async () => {
    const file = join(dir, "not-a-directory.txt");
    await writeFile(file, "x");
    expect(() => validateCwd("relative/path")).toThrow(/absolute/);
    expect(() => validateCwd(join(dir, "gone"))).toThrow(/no longer exists/);
    expect(() => validateCwd(file)).toThrow(/not a directory/);
    expect(() => validateCwd("")).toThrow(/needs a directory/);
  });
});

describe("terminal size", () => {
  it("rounds down and refuses the zero a hidden panel measures", () => {
    expect(clampSize(0, -3)).toEqual({ cols: 1, rows: 1 });
    expect(clampSize(120.9, 40.2)).toEqual({ cols: 120, rows: 40 });
    expect(clampSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ cols: 80, rows: 24 });
  });
});

describe("terminal shell", () => {
  it.skipIf(process.platform === "win32")("runs the account's login shell, not the SHELL the launcher passed", () => {
    expect(terminalShell({ SHELL: "/tmp/payload" }, () => "/bin/bash")).toBe("/bin/bash");
  });

  it.skipIf(process.platform === "win32")("falls back to SHELL, then zsh, only when the account names no shell", () => {
    expect(terminalShell({ SHELL: "/opt/homebrew/bin/fish" }, () => null)).toBe("/opt/homebrew/bin/fish");
    expect(terminalShell({}, () => null)).toBe("/bin/zsh");
  });
});

describe("pty environment", () => {
  it("drops unset values, prefers the login PATH and never hands a shell Electron's node flag", () => {
    const env = ptyEnv({ HOME: "/Users/d", PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", EMPTY: undefined }, "/opt/homebrew/bin:/usr/bin");
    expect(env["PATH"]).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env["HOME"]).toBe("/Users/d");
    expect("ELECTRON_RUN_AS_NODE" in env).toBe(false);
    expect("EMPTY" in env).toBe(false);
    expect(env["TERM"]).toBe("xterm-256color");
  });

  it("keeps this process's PATH when the login shell could not be read", () => {
    expect(ptyEnv({ PATH: "/usr/bin" }, null)["PATH"]).toBe("/usr/bin");
  });
});

describe("pty host", () => {
  let spawned: FakePty[] = [];
  let data: [string, string][] = [];
  let exits: [string, number | null][] = [];
  let settles: string[] = [];
  let gate: Promise<void> | null = null;
  let host: PtyHost;

  beforeEach(() => {
    vi.useFakeTimers();
    spawned = [];
    data = [];
    exits = [];
    settles = [];
    gate = null;
    const spawn: SpawnPty = async () => {
      if (gate) await gate;
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    };
    host = new PtyHost(spawn, { data: (id, chunk) => data.push([id, chunk]), exit: (id, code) => exits.push([id, code]), settled: (id) => settles.push(id) }, 16);
  });
  afterEach(() => {
    host.killAll();
    vi.useRealTimers();
  });

  /**
   * Holds every spawn until the returned function runs. A real spawn takes a
   * process launch, and the window it is open for is where a kill and a resize
   * have no pty to reach; a spawn that resolves immediately never opens it.
   */
  function holdSpawns(): () => void {
    let release = (): void => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      gate = null;
      release();
    };
  }

  const open = (id: string) => host.open({ id, cwd: dir, cols: 80, rows: 24 });

  it("reports a typed command once its output settles, even with nobody watching the shell", async () => {
    await open("t1");
    host.detach("t1");
    host.write("t1", "npm run codegen\r");
    first(spawned).say("\x1b[?2004l\r\r\n");
    first(spawned).say("Generated 3 files\r\n~ % \x1b[?2004h");
    await vi.advanceTimersByTimeAsync(COMMAND_SETTLE_MS);
    expect(settles).toEqual(["t1"]);
    expect(first(spawned).written).toEqual(["npm run codegen\r"]);
  });

  it("reports a command still settling when its shell is killed", async () => {
    await open("t1");
    host.write("t1", "git stash\r");
    first(spawned).say("Saved working directory");
    host.kill("t1");
    expect(settles).toEqual(["t1"]);
  });

  it("blocks updates during shell startup and execution, then fences new shells until a refused update is cancelled", async () => {
    const release = holdSpawns();
    const pending = open("terminal");
    expect(host.prepareForUpdate()).toBe(false);
    release();
    await pending;
    expect(host.prepareForUpdate()).toBe(false);
    first(spawned).finish(0);
    expect(host.prepareForUpdate()).toBe(true);
    await expect(open("next")).rejects.toThrow("restarting to update");
    host.cancelUpdate();
    await expect(open("next")).resolves.toMatchObject({ running: true });
  });
  /** What the panel does: attach first, then open, so nothing written during the round trip is held back. */
  const watch = (id: string) => {
    host.attach(id);
    return open(id);
  };

  it("refuses a directory that went away, on the second open as well as the first", async () => {
    const release = holdSpawns();
    const opening = open("thread-a");
    // Joining a start must not be a way past the check: the panel that fires
    // the second open measured the same worktree the first one did.
    await expect(host.open({ id: "thread-a", cwd: join(dir, "gone"), cols: 80, rows: 24 })).rejects.toThrow(/no longer exists/);
    release();
    await opening;
  });

  it("lets a restart during the spawn start a second shell and keeps hold of it", async () => {
    const release = holdSpawns();
    const abandoned = open("thread-a");
    host.kill("thread-a");
    const restarted = open("thread-a");
    release();

    expect(await abandoned).toEqual({ backlog: "", running: false, exitCode: null });
    expect(await restarted).toEqual({ backlog: "", running: true, exitCode: null });
    expect(spawned.map((pty) => pty.killed)).toEqual([true, false]);
    // The first spawn settling last must not forget the second one, or a
    // later open would start a third shell nothing is holding.
    await open("thread-a");
    expect(spawned).toHaveLength(2);
  });

  it("applies a resize that arrived while the shell was still starting", async () => {
    const release = holdSpawns();
    const opening = open("thread-a");
    host.resize("thread-a", 100, 30.9);
    release();
    await opening;
    expect(first(spawned).sizes).toEqual([{ cols: 100, rows: 30 }]);
  });

  it("ends a shell that was still starting when the app quit", async () => {
    const release = holdSpawns();
    const opening = open("thread-a");
    host.killAll();
    release();
    await opening;
    expect(first(spawned).killed).toBe(true);
  });

  it("posts nothing for a shell nobody is watching, and keeps the bytes for whoever comes back", async () => {
    await open("thread-a");
    const pty = first(spawned);
    for (let i = 0; i < 1000; i += 1) pty.say("yes\n");
    vi.advanceTimersByTime(64);
    // No panel is attached, so a command that never stops costs the ring and
    // nothing else: no batching, no messages to a window nobody is reading.
    expect(data).toEqual([]);

    host.attach("thread-a");
    expect((await open("thread-a")).backlog.endsWith("yes\n")).toBe(true);
    pty.say("back\n");
    vi.advanceTimersByTime(16);
    expect(data).toEqual([["thread-a", "back\n"]]);
  });

  it("routes writes and clamped resizes to the right shell", async () => {
    await open("thread-a");
    await open("thread-b");
    host.write("thread-b", "ls\r");
    host.resize("thread-b", 0, 40.9);
    expect(first(spawned).written).toEqual([]);
    expect(spawned[1]?.written).toEqual(["ls\r"]);
    expect(spawned[1]?.sizes.at(-1)).toEqual({ cols: 1, rows: 40 });
  });

  it("ignores an unknown id rather than throwing at the renderer", () => {
    expect(() => host.write("nobody", "x")).not.toThrow();
    expect(() => host.resize("nobody", 80, 24)).not.toThrow();
    expect(() => host.kill("nobody")).not.toThrow();
    expect(() => host.detach("nobody")).not.toThrow();
  });

  it("keeps the scrollback of a shell that exited, and reports how it ended", async () => {
    await watch("thread-a");
    const pty = first(spawned);
    pty.say("build finished\n");
    pty.finish(0);
    expect(data).toEqual([["thread-a", "build finished\n"]]);
    expect(exits).toEqual([["thread-a", 0]]);
    expect(await open("thread-a")).toEqual({ backlog: "build finished\n", running: false, exitCode: 0 });
    expect(spawned).toHaveLength(1);
  });

  it("forgets the scrollback on kill, and starts a fresh shell on the next open", async () => {
    await watch("thread-a");
    first(spawned).say("secret\n");
    vi.advanceTimersByTime(16);
    host.kill("thread-a");
    expect(first(spawned).killed).toBe(true);
    expect(await open("thread-a")).toEqual({ backlog: "", running: true, exitCode: null });
    expect(spawned).toHaveLength(2);
  });

  it("lets go of a killed shell's handlers and drops its output and exits, so they cannot land in its replacement", async () => {
    await watch("thread-a");
    const dead = first(spawned);
    host.kill("thread-a");
    // A shell that survives SIGHUP cannot hold the handlers.
    expect(dead.listening).toBe(false);
    await open("thread-a");
    dead.say("too late\n");
    dead.finish(1);
    vi.advanceTimersByTime(64);
    expect(data).toEqual([]);
    expect(exits).toEqual([]);
    expect(await open("thread-a")).toEqual({ backlog: "", running: true, exitCode: null });
  });
});
