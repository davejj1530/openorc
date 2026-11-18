import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostChoice, HostState, HostSwitch } from "../shared/host";
import { distroPaths, localPaths, useHostPaths, type HostPreferences } from "./host";
import type { CoreProcess } from "./host-core";
import { importProject, installHostControls, type HostControlsDeps } from "./host-controls";
import { wslDistro } from "./wsl/distro";

interface FakePort extends EventEmitter {
  posted: unknown[];
  closed: boolean;
}

const fake = vi.hoisted(() => ({ handle: vi.fn(), messageBox: vi.fn(), openDialog: vi.fn(), channels: [] as { port2: unknown }[] }));
vi.mock("electron", async () => {
  const events = await import("node:events");
  class Port extends events.EventEmitter {
    posted: unknown[] = [];
    closed = false;
    postMessage(message: unknown): void {
      this.posted.push(message);
    }
    start(): void {}
    close(): void {
      this.closed = true;
    }
  }
  class MessageChannelMain {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      fake.channels.push(this);
    }
  }
  return { ipcMain: { handle: fake.handle }, dialog: { showMessageBox: fake.messageBox, showOpenDialog: fake.openDialog }, MessageChannelMain };
});

const APP = "https://app.test/";
const UBUNTU: HostChoice = { kind: "wsl", distro: "Ubuntu" };
const WINDOW = {} as BrowserWindow;

/** The controls over a place that starts on this PC, with what they were asked to do recorded. */
function controls(over: Partial<HostControlsDeps> = {}) {
  let chosen: HostChoice = { kind: "local" };
  const did = { closed: 0, set: [] as HostChoice[], restarted: [] as (string | undefined)[] };
  const deps: HostControlsDeps = {
    preferences: { choice: () => chosen, set: (host: HostChoice) => void (did.set.push(host), (chosen = host)) } as unknown as HostPreferences,
    current: () => chosen,
    distros: async () => [{ name: "Ubuntu", default: true, version: 2 }],
    isAppOrigin: (url) => url === APP,
    closeCore: async () => (did.closed++, null),
    restart: (folder) => void did.restarted.push(folder),
    thisComputer: "this PC",
    home: () => null,
    platform: "win32",
    ...over,
  };
  return { ...installHostControls(deps), did, run: (host: HostChoice) => void (chosen = host) };
}

function handler<Result>(name: string) {
  return fake.handle.mock.calls.findLast((call) => call[0] === `host:${name}`)![1] as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Result>;
}
function event(url = APP, sameFrame = true): IpcMainInvokeEvent {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: sameFrame ? frame : { url } } } as unknown as IpcMainInvokeEvent;
}
const picks = (folder: string) => fake.openDialog.mockResolvedValue({ canceled: false, filePaths: [folder] });
const answers = (response: number) => fake.messageBox.mockResolvedValue({ response });

beforeEach(() => {
  vi.clearAllMocks();
  fake.channels.length = 0;
  useHostPaths(localPaths("/profile"));
});

describe("switching where OpenOrc runs", () => {
  it("closes the core, keeps the choice, and starts again there", async () => {
    const { use, did } = controls();
    expect(await use(UBUNTU)).toEqual({ ok: true });
    expect(did).toEqual({ closed: 1, set: [UBUNTU], restarted: [undefined] });
  });

  it("does nothing when OpenOrc already runs there", async () => {
    const { use, did, run } = controls();
    run(UBUNTU);
    expect(await use({ kind: "wsl", distro: "ubuntu" })).toEqual({ ok: true });
    expect(did).toEqual({ closed: 0, set: [], restarted: [] });
  });

  it("refuses a distribution this PC does not have, before anything closes", async () => {
    const { use, did } = controls();
    expect(await use({ kind: "wsl", distro: "Arch" })).toEqual({ ok: false, reason: "WSL: Arch is not installed on this PC." });
    expect(did.closed).toBe(0);
  });

  it("stays where it was when the core will not close yet, and says why in the core's words", async () => {
    const { use, did } = controls({ closeCore: async () => "Wait for agent work, approvals, and context maintenance to finish first, then switch." });
    expect(await use(UBUNTU)).toEqual({ ok: false, reason: "Wait for agent work, approvals, and context maintenance to finish first, then switch." });
    expect(did).toEqual({ closed: 0, set: [], restarted: [] });
  });

  it("keeps the distribution's name as WSL spells it, however it was asked for", async () => {
    const { use, did } = controls();
    await use({ kind: "wsl", distro: "ubuntu" }, "/home/me/repo");
    expect(did.set).toEqual([UBUNTU]);
    expect(did.restarted).toEqual(["/home/me/repo"]);
  });

  it("refuses a second switch while one is on its way, and takes the next once it is done", async () => {
    const closes: ((blocked: string | null) => void)[] = [];
    const { use, did } = controls({ closeCore: () => new Promise((resolve) => closes.push(resolve)) });
    const first = use(UBUNTU);
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(await use({ kind: "local" })).toEqual({ ok: false, reason: "OpenOrc is already switching where it runs." });
    closes[0]!(null);
    expect(await first).toEqual({ ok: true });
    const back = use({ kind: "local" });
    await vi.waitFor(() => expect(closes).toHaveLength(2));
    closes[1]!(null);
    expect(await back).toEqual({ ok: true });
    expect(did.set).toEqual([UBUNTU, { kind: "local" }]);
  });
});

describe("the windows' controls", () => {
  it("answer only the app's main frame", async () => {
    const { did } = controls();
    for (const stranger of [event("https://other.test/"), event(APP, false)]) {
      await expect(handler("get")(stranger)).rejects.toThrow("Only the app window");
      expect(() => handler("use")(stranger, UBUNTU)).toThrow("Only the app window");
    }
    expect(did.closed).toBe(0);
  });

  it("refuse a place that is none", async () => {
    const { did } = controls();
    for (const value of [null, "Ubuntu", {}, { kind: "ssh", distro: "Ubuntu" }, { kind: "wsl" }, { kind: "wsl", distro: "Ubuntu; calc" }, { kind: "wsl", distro: "../etc" }])
      expect(await handler<HostSwitch>("use")(event(), value)).toEqual({ ok: false, reason: "That is not a place OpenOrc can run." });
    expect(did.closed).toBe(0);
    expect(await handler<HostSwitch>("use")(event(), UBUNTU)).toEqual({ ok: true });
  });

  it("say where OpenOrc runs and where else it could", async () => {
    controls();
    expect(await handler<HostState>("get")(event())).toEqual({ current: { kind: "local" }, distros: [{ name: "Ubuntu", default: true }] });
  });

  it("always offer the distribution OpenOrc runs in, as WSL spells it, even when the listing comes back empty", async () => {
    const { run } = controls();
    run({ kind: "wsl", distro: "ubuntu" });
    expect(await handler<HostState>("get")(event())).toEqual({ current: UBUNTU, distros: [{ name: "Ubuntu", default: true }] });
    const unlisted = controls({ distros: async () => [] });
    unlisted.run(UBUNTU);
    expect(await handler<HostState>("get")(event())).toEqual({ current: UBUNTU, distros: [{ name: "Ubuntu", default: false }] });
  });
});

describe("the folder chooser", () => {
  const SHARE = "\\\\wsl.localhost\\Ubuntu\\home\\me\\skills\\foo";

  it("gives back a folder on this PC as it is, whatever it is for", async () => {
    const { pickFolder } = controls();
    picks("C:\\Users\\me\\repo");
    expect(await pickFolder(WINDOW, true)).toBe("C:\\Users\\me\\repo");
    expect(await pickFolder(WINDOW, false)).toBe("C:\\Users\\me\\repo");
    fake.openDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await pickFolder(WINDOW, true)).toBeNull();
    expect(fake.messageBox).not.toHaveBeenCalled();
  });

  it("offers to run in the distribution a project's folder is inside, and adds the folder there", async () => {
    const { pickFolder, did } = controls();
    picks(SHARE);
    answers(0);
    expect(await pickFolder(WINDOW, true)).toBeNull();
    expect(did.set).toEqual([UBUNTU]);
    expect(did.restarted).toEqual(["/home/me/skills/foo"]);
    // What stops on this PC meanwhile is said before anyone agrees.
    expect(fake.messageBox.mock.calls[0]![1].detail).toMatch(/schedules, Slack and phone access/);
  });

  it("opens the project's folder from Windows when asked, and does nothing when the offer is closed", async () => {
    const { pickFolder, did } = controls();
    picks(SHARE);
    answers(1);
    expect(await pickFolder(WINDOW, true)).toBe(SHARE);
    answers(2);
    expect(await pickFolder(WINDOW, true)).toBeNull();
    expect(did).toEqual({ closed: 0, set: [], restarted: [] });
  });

  it("never switches for a folder that is not to be a project: a skill's folder inside a distribution opens from Windows", async () => {
    const { pickFolder, did } = controls();
    picks(SHARE);
    expect(await pickFolder(WINDOW, false)).toBe(SHARE);
    expect(fake.messageBox).not.toHaveBeenCalled();
    expect(did).toEqual({ closed: 0, set: [], restarted: [] });
  });

  it("opens a folder inside the distribution OpenOrc runs in by its path there", async () => {
    const { pickFolder, run } = controls();
    run(UBUNTU);
    useHostPaths(distroPaths(wslDistro("Ubuntu", "wsl.exe"), () => "/home/me/.openorc-wsl/data", "C:\\nowhere"));
    picks(SHARE);
    expect(await pickFolder(WINDOW, false)).toBe("/home/me/skills/foo");
    expect(await pickFolder(WINDOW, true)).toBe("/home/me/skills/foo");
  });

  it("from inside a distribution, switches to this PC for a project there, and only says so for any other folder", async () => {
    const { pickFolder, run, did } = controls();
    run(UBUNTU);
    useHostPaths(distroPaths(wslDistro("Ubuntu", "wsl.exe"), () => null, "C:\\nowhere"));
    picks("C:\\Users\\me\\repo");
    answers(0);
    expect(await pickFolder(WINDOW, false)).toBeNull();
    expect(fake.messageBox.mock.calls[0]![1]).toMatchObject({ message: "This folder is not inside WSL: Ubuntu", buttons: ["OK"] });
    expect(did).toEqual({ closed: 0, set: [], restarted: [] });
    expect(await pickFolder(WINDOW, true)).toBeNull();
    expect(did.set).toEqual([{ kind: "local" }]);
    expect(did.restarted).toEqual(["C:\\Users\\me\\repo"]);
  });

  it("says why when the switch a folder asked for is refused", async () => {
    const { pickFolder } = controls({ closeCore: async () => "A terminal still has a shell running. Use End shell in each terminal, then switch." });
    picks(SHARE);
    answers(0);
    expect(await pickFolder(WINDOW, true)).toBeNull();
    expect(fake.messageBox.mock.calls[1]![1]).toMatchObject({
      message: "OpenOrc can’t switch to WSL: Ubuntu yet",
      detail: "A terminal still has a shell running. Use End shell in each terminal, then switch.",
    });
  });
});

describe("adding a folder on a core that is starting", () => {
  /** A core as main holds one, and main's end of the channel it was handed. */
  function starting() {
    const core = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: () => true }) as unknown as CoreProcess & EventEmitter;
    const done = vi.fn();
    importProject(core, "/home/me/repo", done);
    const [mine, video] = fake.channels.map((channel) => channel.port2 as FakePort);
    if (!mine || !video) throw new Error("expected a channel for requests and one for video");
    return { core, done, mine, video };
  }

  it("asks once the core is ready, once, and closes its channel on the answer", () => {
    const { done, mine, video } = starting();
    mine.emit("message", { data: { type: "startup", message: "Starting Ubuntu…" } });
    expect(mine.posted).toEqual([]);
    mine.emit("message", { data: { type: "ready", pid: 1, mcpPort: 2 } });
    mine.emit("message", { data: { type: "ready", pid: 1, mcpPort: 2 } });
    expect(mine.posted).toEqual([{ type: "rpc", id: 1, method: "projects.import", params: { rootPath: "/home/me/repo" } }]);
    mine.emit("message", { data: { type: "rpc.result", id: 1, result: {} } });
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(mine.closed && video.closed).toBe(true);
  });

  it("hands on why the core would not add the folder", () => {
    const { done, mine } = starting();
    mine.emit("message", { data: { type: "ready", pid: 1, mcpPort: 2 } });
    mine.emit("message", { data: { type: "rpc.error", id: 1, message: "/home/me/repo is not a folder." } });
    expect(done).toHaveBeenCalledExactlyOnceWith("/home/me/repo is not a folder.");
  });

  it("closes its channel, with no answer, when the core stops first", () => {
    const { core, done, mine, video } = starting();
    core.emit("exit", 1);
    expect(mine.closed && video.closed).toBe(true);
    expect(done).not.toHaveBeenCalled();
    expect(core.listenerCount("exit")).toBe(0);
  });
});
