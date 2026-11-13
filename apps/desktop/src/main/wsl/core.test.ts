import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeFrame, FrameReader, type WslFrame } from "../../shared/wsl-frames";
import { WslCore, type CoreChild, type WindowChannel, type WslCoreStart } from "./core";

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Stands in for a window's MessagePortMain: records what main posts to it, and sends what the window would. */
class FakeWindow extends EventEmitter implements WindowChannel {
  readonly received: unknown[] = [];
  started = false;
  closed = false;
  postMessage(message: unknown): void {
    this.received.push(message);
  }
  start(): void {
    this.started = true;
  }
  close(): void {
    this.closed = true;
  }
  say(data: unknown): void {
    this.emit("message", { data });
  }
}

/** Stands in for wsl.exe with the core behind it: records the frames main writes, and writes the core's. */
class FakeChild extends EventEmitter implements CoreChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: WslFrame[] = [];
  killed = false;
  inputEnded = false;

  constructor() {
    super();
    const reader = new FrameReader((frame) => this.written.push(frame));
    this.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
    this.stdin.on("end", () => (this.inputEnded = true));
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
  frame(frame: WslFrame): void {
    this.stdout.write(encodeFrame(frame));
  }
}

const START: Extract<WslFrame, { t: "start" }> = { t: "start", dataDir: "/home/me/.openorc-wsl/data", fileKey: "key" };

/** A core whose preparation the test finishes by hand. */
function preparing() {
  const child = new FakeChild();
  let progress!: (text: string) => void;
  let finish!: (start: WslCoreStart) => void;
  let fail!: (error: Error) => void;
  let ending!: AbortSignal;
  const log: string[] = [];
  const core = new WslCore(
    (say, signal) => {
      progress = say;
      ending = signal;
      return new Promise<WslCoreStart>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    (line) => log.push(line),
  );
  return { core, child, log, ending: () => ending, progress: (text: string) => progress(text), start: () => finish({ child, start: START }), fail: (error: Error) => fail(error) };
}

async function running() {
  const fixture = preparing();
  fixture.start();
  await settled();
  return fixture;
}

describe("the core inside a distribution, as main sees it", () => {
  it("writes the start line first, then relays each window's messages under its own number", async () => {
    const { core, child } = await running();
    const first = new FakeWindow();
    const second = new FakeWindow();
    core.connect(first);
    core.connect(second);
    first.say({ type: "rpc", id: 1, method: "projects.list" });
    second.say({ type: "rpc", id: 1, method: "threads.list" });
    await settled();
    expect(child.written).toEqual([
      START,
      { t: "open", window: 1 },
      { t: "open", window: 2 },
      { t: "rpc", window: 1, data: { type: "rpc", id: 1, method: "projects.list" } },
      { t: "rpc", window: 2, data: { type: "rpc", id: 1, method: "threads.list" } },
    ]);
    expect(first.started && second.started).toBe(true);
  });

  it("gives each window only what the core sent to it", async () => {
    const { core, child } = await running();
    const first = new FakeWindow();
    const second = new FakeWindow();
    core.connect(first);
    core.connect(second);
    child.frame({ t: "rpc", window: 2, data: { type: "rpc.result", id: 1, result: "second" } });
    child.frame({ t: "rpc", window: 1, data: { type: "ready", pid: 7, mcpPort: 1 } });
    child.frame({ t: "rpc", window: 9, data: "nobody" });
    await settled();
    expect(first.received).toEqual([{ type: "ready", pid: 7, mcpPort: 1 }]);
    expect(second.received).toEqual([{ type: "rpc.result", id: 1, result: "second" }]);
  });

  it("carries the private channel both ways", async () => {
    const { core, child } = await running();
    const heard: unknown[] = [];
    core.on("message", (message) => heard.push(message));
    core.postMessage({ type: "presence.result", id: 3, inUse: true });
    child.frame({ t: "host", data: { type: "presence", id: 3 } });
    await settled();
    expect(child.written.at(-1)).toEqual({ t: "host", data: { type: "presence.result", id: 3, inUse: true } });
    expect(heard).toEqual([{ type: "presence", id: 3 }]);
  });

  it("keeps what is sent while the distribution is made ready, and sends it in order once the core is up", async () => {
    const { core, child, start } = preparing();
    const window = new FakeWindow();
    core.connect(window);
    window.say({ type: "rpc", id: 1, method: "projects.list" });
    core.postMessage({ type: "power", state: "resume" });
    expect(child.written).toEqual([]);
    start();
    await settled();
    expect(child.written).toEqual([
      START,
      { t: "open", window: 1 },
      { t: "rpc", window: 1, data: { type: "rpc", id: 1, method: "projects.list" } },
      { t: "host", data: { type: "power", state: "resume" } },
    ]);
  });

  it("tells windows what the core waits on, including one that connects mid-way", async () => {
    const { core, progress } = preparing();
    const early = new FakeWindow();
    core.connect(early);
    progress("Starting Ubuntu…");
    progress("Setting up OpenOrc in Ubuntu: downloading Node 24.22.2…");
    const late = new FakeWindow();
    core.connect(late);
    expect(early.received).toEqual([
      { type: "startup", message: "Starting Ubuntu…" },
      { type: "startup", message: "Setting up OpenOrc in Ubuntu: downloading Node 24.22.2…" },
    ]);
    expect(late.received).toEqual([{ type: "startup", message: "Setting up OpenOrc in Ubuntu: downloading Node 24.22.2…" }]);
  });

  it("says a window closed, once", async () => {
    const { core, child } = await running();
    const window = new FakeWindow();
    core.connect(window);
    window.emit("close");
    window.emit("close");
    await settled();
    expect(child.written.filter((frame) => frame.t === "close")).toEqual([{ t: "close", window: 1 }]);
  });

  it("reports the core's exit with its code and closes every window's channel", async () => {
    const { core, child } = await running();
    const window = new FakeWindow();
    core.connect(window);
    const exits: number[] = [];
    core.on("exit", (code) => exits.push(code));
    child.emit("close", 0);
    child.emit("close", 0);
    expect(exits).toEqual([0]);
    expect(window.closed).toBe(true);
    const late = new FakeWindow();
    core.connect(late);
    expect(late.closed).toBe(true);
  });

  it("reports a failed setup in its own words, then as an exit", async () => {
    const { core, fail } = preparing();
    const window = new FakeWindow();
    core.connect(window);
    const failures: string[] = [];
    const exits: number[] = [];
    core.on("failed", (error: Error) => failures.push(error.message));
    core.on("exit", (code) => exits.push(code));
    fail(new Error("Ubuntu has no tar."));
    await settled();
    expect(failures).toEqual(["Ubuntu has no tar."]);
    expect(exits).toEqual([1]);
    expect(window.closed).toBe(true);
  });

  it("ends a running core by closing its input, which the core reads as the app leaving", async () => {
    const { core, child } = await running();
    expect(core.kill()).toBe(true);
    await settled();
    expect(child.inputEnded).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("ends a core that starts after it was told to stop", async () => {
    const { core, child, start, ending } = preparing();
    const exits: number[] = [];
    core.on("exit", (code) => exits.push(code));
    expect(ending().aborted).toBe(false);
    core.kill();
    // Whatever was making the distribution ready is told to stop, so it installs nothing for nobody.
    expect(ending().aborted).toBe(true);
    start();
    await settled();
    expect(exits).toEqual([1]);
    expect(child.killed).toBe(true);
    expect(child.written).toEqual([]);
  });

  it("logs what the core prints, line by line, and what arrives on its output that is no frame", async () => {
    const { child, log } = await running();
    child.stderr.write("[core] up, pid 12\npartial");
    child.stderr.write(" line\n");
    child.stdout.write("The distribution is shutting down.\n");
    await settled();
    expect(log).toEqual(["[core] [core] up, pid 12", "[core] partial line", "[core] The distribution is shutting down."]);
  });

  it("keeps the last few lines the core printed, to say why it stopped", async () => {
    const { core, child } = await running();
    expect(core.lastWords).toBe("");
    for (let line = 1; line <= 20; line++) child.stderr.write(`line ${line}\n`);
    child.stderr.write("\nError: disk I/O error\n");
    await settled();
    expect(core.lastWords.split("\n")).toHaveLength(12);
    expect(core.lastWords.split("\n").at(-1)).toBe("Error: disk I/O error");
    expect(core.lastWords).not.toContain("line 9\n");
  });
});
