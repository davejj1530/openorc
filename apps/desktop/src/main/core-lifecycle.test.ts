import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostChoice } from "../shared/host";
import { encodeFrame, FrameReader, type WslFrame } from "../shared/wsl-frames";
import { CoreLifecycle, type DistroAnswer } from "./core-lifecycle";
import type { CoreProcess } from "./host-core";
import { WslCore, type CoreChild, type WslCoreStart } from "./wsl/core";
import { ALREADY_RUNNING } from "./wsl/runtime";

const settled = () => new Promise((resolve) => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

const UBUNTU: HostChoice = { kind: "wsl", distro: "Ubuntu" };
const START: Extract<WslFrame, { t: "start" }> = { t: "start", dataDir: "/home/me/.openorc-wsl/profiles/0123456789abcdef/data", fileKey: "key" };

interface Posted {
  type: string;
  id?: string;
  purpose?: string;
}

/** Stands in for the core in a utility process: records what main posts, and answers a close as the test says. */
class LocalCore extends EventEmitter {
  readonly posted: Posted[] = [];
  killed = false;
  postMessage(message: Posted): void {
    this.posted.push(message);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** Answers the close main asked for last. */
  answer(type: "update:prepared" | "update:blocked", more: object = {}): void {
    this.emit("message", { type, id: this.posted.findLast((message) => message.type === "update:prepare")?.id, ...more });
  }
}

/** Stands in for wsl.exe with the core behind it. */
class FakeWsl extends EventEmitter implements CoreChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly heard: Posted[] = [];

  constructor() {
    super();
    const reader = new FrameReader((frame) => {
      if (frame.t === "host") this.heard.push(frame.data as Posted);
    });
    this.stdin.on("data", (chunk: Buffer) => reader.push(chunk));
  }

  kill(): boolean {
    return true;
  }
  /** The core says something on its private channel. */
  say(data: unknown): void {
    this.stdout.write(encodeFrame({ t: "host", data }));
  }
  /** wsl.exe ends, everything it wrote read. */
  end(code: number): void {
    this.emit("close", code);
  }
}

/** A core in a distribution, the real relay, whose setup the test finishes or fails by hand. */
function distroCore() {
  let finish!: (start: WslCoreStart) => void;
  let fail!: (error: Error) => void;
  const core = new WslCore(
    () => new Promise<WslCoreStart>((resolve, reject) => ((finish = resolve), (fail = reject))),
    () => undefined,
  );
  const wsl = new FakeWsl();
  const up = async () => {
    finish({ child: wsl, start: START });
    await settled();
  };
  const failed = async (reason: string) => {
    fail(new Error(reason));
    await settled();
  };
  return { core, wsl, up, failed };
}

function harness(host: HostChoice = { kind: "local" }) {
  const place = { host, shellsIdle: true };
  /** The cores the next starts hand out, in order. */
  const next: CoreProcess[] = [];
  const started: CoreProcess[] = [];
  const did = { connected: [] as [CoreProcess, string][], reloaded: [] as string[][], left: 0, released: 0, quit: 0, madeLocal: 0, imported: [] as [CoreProcess, string][], notAdded: [] as string[] };
  const asked: { distro: string; reason: string; answer(answer: DistroAnswer): Promise<void> }[] = [];
  const imports: ((error?: string) => void)[] = [];
  const lifecycle = new CoreLifecycle<string>({
    host: () => place.host,
    start: () => {
      const core = next.shift();
      if (!core) throw new Error("A core started that the test did not expect.");
      started.push(core);
      return core;
    },
    connect: (core, window) => void did.connected.push([core, window]),
    everyWindow: () => ["main", "second"],
    reload: (windows) => void did.reloaded.push([...windows]),
    leave: () => void did.left++,
    shells: { hold: () => place.shellsIdle, release: () => void did.released++ },
    ask: (distro, reason) =>
      new Promise((resolve) =>
        asked.push({
          distro,
          reason,
          answer: async (answer) => {
            resolve(answer);
            await settled();
          },
        }),
      ),
    chooseLocal: () => {
      did.madeLocal++;
      place.host = { kind: "local" };
    },
    quit: () => void did.quit++,
    importProject: (core, folder, done) => {
      did.imported.push([core, folder]);
      imports.push(done);
    },
    folderNotAdded: (folder, reason) => void did.notAdded.push(`${folder}: ${reason}`),
  });
  /** Begins with one core running in the place the harness was made for. */
  const begin = <Core extends CoreProcess>(core: Core): Core => {
    next.push(core);
    lifecycle.begin();
    return core;
  };
  return { lifecycle, place, next, started, did, asked, imports, begin };
}

/** A switch from this computer into Ubuntu for a folder there, up to its core starting to be set up. */
async function switchedForFolder() {
  const h = harness();
  const local = h.begin(new LocalCore());
  const closing = h.lifecycle.closeToSwitch();
  local.answer("update:prepared");
  local.emit("exit", 0);
  await closing;
  h.place.host = UBUNTU;
  const first = distroCore();
  h.next.push(first.core);
  h.lifecycle.restart("/home/me/repo");
  return { ...h, first };
}

describe("the core's windows", () => {
  it("hands each window the core, and starts one again for the next window once it has stopped on this computer", () => {
    const { lifecycle, next, did, asked, begin } = harness();
    const first = begin(new LocalCore());
    lifecycle.connect("main");
    first.emit("exit", 1);
    const second = new LocalCore();
    next.push(second);
    lifecycle.connect("main");
    lifecycle.connect("second");
    expect(did.connected).toEqual([
      [first, "main"],
      [second, "main"],
      [second, "second"],
    ]);
    expect(asked).toEqual([]);
  });
});

describe("switching where the core runs", () => {
  it("leaves a core that refuses running, and reloads only the windows it turned away meanwhile", async () => {
    const { lifecycle, started, did, begin } = harness();
    const core = begin(new LocalCore());
    const closing = lifecycle.closeToSwitch();
    lifecycle.connect("second");
    expect(core.posted).toEqual([{ type: "update:prepare", id: expect.any(String), purpose: "switch" }]);
    expect(did.connected).toEqual([]);
    core.answer("update:blocked", { reason: "Wait for agent work to finish first, then switch." });
    await expect(closing).resolves.toBe("Wait for agent work to finish first, then switch.");
    expect(did).toMatchObject({ reloaded: [["second"]], released: 1 });
    lifecycle.connect("second");
    expect(did.connected).toEqual([[core, "second"]]);
    expect(started).toEqual([core]);
  });

  it("asks the core nothing while a terminal has a shell running", async () => {
    const { lifecycle, place, did, begin } = harness();
    const core = begin(new LocalCore());
    place.shellsIdle = false;
    await expect(lifecycle.closeToSwitch()).resolves.toMatch(/terminal still has a shell running/);
    expect(core.posted).toEqual([]);
    lifecycle.connect("main");
    expect(did.connected).toEqual([[core, "main"]]);
  });

  it("reloads every window when the core ended without closing cleanly, so they start one again where it was", async () => {
    const { lifecycle, next, did, begin } = harness();
    const core = begin(new LocalCore());
    const closing = lifecycle.closeToSwitch();
    core.emit("exit", 1);
    await expect(closing).resolves.toMatch(/did not confirm a clean shutdown/);
    expect(did.reloaded).toEqual([["main", "second"]]);
    const again = new LocalCore();
    next.push(again);
    lifecycle.connect("main");
    expect(did.connected).toEqual([[again, "main"]]);
  });

  it("starts the core in the new place once the old one has closed, with every window reloaded onto it and the folder added there", async () => {
    const { started, did, first } = await switchedForFolder();
    expect(started.at(-1)).toBe(first.core);
    expect(did).toMatchObject({ left: 1, reloaded: [["main", "second"]], imported: [[first.core, "/home/me/repo"]] });
  });

  it("ends a core still being set up in a distribution without asking it or about it", async () => {
    const { lifecycle, place, next, started, did, asked, begin } = harness(UBUNTU);
    const { core } = distroCore();
    begin(core);
    await expect(lifecycle.closeToSwitch()).resolves.toBeNull();
    expect(core.starting).toBe(false);
    place.host = { kind: "local" };
    const local = new LocalCore();
    next.push(local);
    lifecycle.restart();
    await settled();
    expect(started).toEqual([core, local]);
    expect(did.reloaded).toEqual([["main", "second"]]);
    expect(asked).toEqual([]);
  });

  it("waits for a distribution's core that said it is closing, however long it takes, and asks nothing about its exit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { lifecycle, asked, begin } = harness(UBUNTU);
    const { core, wsl, up } = distroCore();
    begin(core);
    await up();
    const done = vi.fn();
    const closing = lifecycle.closeToSwitch().then(done);
    await settled();
    const request = wsl.heard.findLast((message) => message.type === "update:prepare");
    expect(request).toMatchObject({ purpose: "switch" });
    wsl.say({ type: "update:prepared", id: request?.id });
    await settled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(done).not.toHaveBeenCalled();
    wsl.end(0);
    await closing;
    expect(done).toHaveBeenCalledWith(null);
    expect(asked).toEqual([]);
  });

  it("is refused while an update installs, and an update while a switch closes the core", async () => {
    const { lifecycle, begin } = harness();
    const core = begin(new LocalCore());
    const switching = lifecycle.closeToSwitch();
    await expect(lifecycle.closeForUpdate()).resolves.toMatch(/switching where it runs/);
    expect(core.posted).toHaveLength(1);
    core.answer("update:blocked", { reason: "Busy" });
    await switching;
    const updating = lifecycle.closeForUpdate();
    await expect(lifecycle.closeToSwitch()).resolves.toMatch(/installing an update/);
    core.answer("update:blocked", { reason: "Busy" });
    await expect(updating).resolves.toBe("Busy");
  });
});

describe("a distribution that cannot run the core", () => {
  it("asks once with the reason, starts nothing until the answer, and tries again with the folder that was waiting", async () => {
    const { lifecycle, next, started, did, asked, imports, first } = await switchedForFolder();
    await first.failed("Ubuntu has no tar, which OpenOrc uses to install its core there.");
    expect(asked).toMatchObject([{ distro: "Ubuntu", reason: "Ubuntu has no tar, which OpenOrc uses to install its core there." }]);
    lifecycle.connect("main");
    expect(did.connected).toEqual([]);
    const second = distroCore();
    next.push(second.core);
    await asked[0]!.answer("retry");
    expect(started.at(-1)).toBe(second.core);
    expect(did.imported).toEqual([
      [first.core, "/home/me/repo"],
      [second.core, "/home/me/repo"],
    ]);
    expect(did.madeLocal).toBe(0);
    // Once a core has answered for the folder, a later start has nothing left to add.
    imports.at(-1)!();
    await second.failed("Ubuntu did not answer.");
    next.push(distroCore().core);
    await asked[1]!.answer("retry");
    expect(did.imported).toHaveLength(2);
  });

  it("goes back to this computer only when told to, and drops the folder that lives in the distribution", async () => {
    const { next, started, did, asked, first } = await switchedForFolder();
    await first.failed("Ubuntu did not answer.");
    const local = new LocalCore();
    next.push(local);
    await asked[0]!.answer("local");
    expect(did.madeLocal).toBe(1);
    expect(started.at(-1)).toBe(local);
    expect(did.imported).toEqual([[first.core, "/home/me/repo"]]);
  });

  it("quits when the question is closed, and changes nothing", async () => {
    const { started, did, asked, first } = await switchedForFolder();
    await first.failed("Ubuntu did not answer.");
    await asked[0]!.answer("quit");
    expect(did).toMatchObject({ quit: 1, madeLocal: 0 });
    expect(started.at(-1)).toBe(first.core);
  });

  it("says why a core that was running stopped: another one runs there, or how it exited and what it said last", async () => {
    const { next, asked, begin } = harness(UBUNTU);
    const refused = distroCore();
    begin(refused.core);
    await refused.up();
    refused.wsl.end(ALREADY_RUNNING);
    expect(asked[0]!.reason).toMatch(/already running in Ubuntu/);
    const stopped = distroCore();
    next.push(stopped.core);
    await asked[0]!.answer("retry");
    await stopped.up();
    stopped.wsl.stderr.write("Killed\n");
    await settled();
    stopped.wsl.end(137);
    expect(asked[1]!.reason).toMatch(/exit 137[^]*Killed/);
  });

  it("lets a switch chosen while the question is open take over from it", async () => {
    const { lifecycle, place, next, started, did, asked, first } = await switchedForFolder();
    await first.failed("Ubuntu did not answer.");
    await expect(lifecycle.closeToSwitch()).resolves.toBeNull();
    place.host = { kind: "local" };
    const local = new LocalCore();
    next.push(local);
    lifecycle.restart();
    const reloads = did.reloaded.length;
    await asked[0]!.answer("retry");
    expect(started.at(-1)).toBe(local);
    expect(did.reloaded).toHaveLength(reloads);
  });
});

describe("closing the core for an update", () => {
  it("goes back to serving windows when the core refuses", async () => {
    const { lifecycle, did, begin } = harness();
    const core = begin(new LocalCore());
    const closing = lifecycle.closeForUpdate();
    lifecycle.connect("main");
    expect(did.connected).toEqual([]);
    core.answer("update:blocked", { reason: "Agent still running" });
    await expect(closing).resolves.toBe("Agent still running");
    expect(did.released).toBe(1);
    lifecycle.connect("main");
    expect(did.connected).toEqual([[core, "main"]]);
  });

  it("hands no window a core once it has closed for the update", async () => {
    const { lifecycle, started, did, begin } = harness();
    const core = begin(new LocalCore());
    const closing = lifecycle.closeForUpdate();
    core.answer("update:prepared");
    core.emit("exit", 0);
    await expect(closing).resolves.toBeNull();
    lifecycle.connect("main");
    expect(did.connected).toEqual([]);
    expect(started).toEqual([core]);
  });

  it("says the core is unavailable when none runs, and holds nothing for it", async () => {
    const { lifecycle, next, did, begin } = harness();
    begin(new LocalCore()).emit("exit", 1);
    await expect(lifecycle.closeForUpdate()).rejects.toThrow("The core is unavailable");
    expect(did.released).toBe(1);
    const again = new LocalCore();
    next.push(again);
    lifecycle.connect("main");
    expect(did.connected).toEqual([[again, "main"]]);
  });
});

describe("quitting", () => {
  it("holds the quit until the core has closed, asks it once, and ends it only when it does not close in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { lifecycle, did, begin } = harness();
    const core = begin(new LocalCore());
    expect(lifecycle.beforeQuit()).toBe(true);
    expect(lifecycle.beforeQuit()).toBe(true);
    expect(core.posted).toEqual([{ type: "shutdown" }]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(core.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(core.killed).toBe(true);
    core.emit("exit", 1);
    expect(did.quit).toBe(1);
    expect(lifecycle.beforeQuit()).toBe(false);
  });

  it("ends a core still being set up in a distribution at once, and asks nothing about it", () => {
    const { lifecycle, did, asked, begin } = harness(UBUNTU);
    const { core } = distroCore();
    begin(core);
    expect(lifecycle.beforeQuit()).toBe(true);
    expect(core.starting).toBe(false);
    expect(did.quit).toBe(1);
    expect(asked).toEqual([]);
    expect(lifecycle.beforeQuit()).toBe(false);
  });

  it("takes over from a switch that was closing the core, so nothing starts anywhere else", async () => {
    const { lifecycle, did, begin } = harness();
    const core = begin(new LocalCore());
    const switching = lifecycle.closeToSwitch();
    core.answer("update:prepared");
    expect(lifecycle.beforeQuit()).toBe(true);
    core.emit("exit", 0);
    await expect(switching).resolves.toBe("OpenOrc is quitting.");
    expect(did).toMatchObject({ quit: 1, reloaded: [] });
  });

  it("starts no core for a window that asks while the app is leaving", () => {
    const { lifecycle, started, did, begin } = harness();
    const core = begin(new LocalCore());
    lifecycle.beforeQuit();
    core.emit("exit", 0);
    lifecycle.connect("main");
    expect(did.connected).toEqual([]);
    expect(started).toEqual([core]);
  });
});
