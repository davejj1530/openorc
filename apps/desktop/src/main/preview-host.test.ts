import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_FRAME_BYTES, type PreviewHostCapture } from "@openorc/protocol";

/**
 * Enough of Electron for the Preview's main half: windows that hold views, a pane's contents with its own debugger
 * (where the screenshot is encoded) and its last painted frame (what capturePage hands back).
 */
const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  class FakeEmitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  /** Bytes standing in for a JPEG: what was asked, padded to the size the page would encode to. */
  const jpegOf = (label: string, size: number) => Buffer.concat([Buffer.from(label), Buffer.alloc(Math.max(0, size - label.length), 7)]);

  let contentsIds = 0;
  const allContents = new Map<number, FakeContents>();
  type FakeImage = { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(options: { width: number }): FakeImage; toJPEG(quality: number): Buffer };

  class FakeContents extends FakeEmitter {
    readonly id = ++contentsIds;
    owner: FakeWindow | null = null;
    url = "";
    title = "";
    loading = false;
    destroyed = false;
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    /** The visual viewport in CSS pixels, its scroll offset and the device's pixel ratio. */
    viewport = { width: 540, height: 714, pageX: 0, pageY: 0, ratio: 2 };
    /** What the page shows now; the same content encodes to the same bytes. */
    content = "frame-1";
    /** Bytes a frame encodes to in main, by its quality and width. */
    encodedSize: (quality: number, width: number) => number = () => 40 * 1024;
    /** Never answer Page.captureScreenshot, as a view in a minimized window does not. */
    screenshotHangs = false;
    /** Never answer capturePage, as a view in a hidden window does not until the window shows again. */
    paintHangs = false;
    readonly screenshots: { quality: number; clip: { x: number; y: number; width: number; height: number; scale: number } }[] = [];
    readonly captures: unknown[][] = [];
    attachedDebugger = false;
    readonly debugger = {
      isAttached: () => this.attachedDebugger,
      attach: () => {
        this.attachedDebugger = true;
      },
      sendCommand: (method: string, params: { quality: number; clip: { x: number; y: number; width: number; height: number; scale: number } }) => {
        const { width, height, pageX, pageY } = this.viewport;
        if (method === "Page.getLayoutMetrics") return Promise.resolve({ cssVisualViewport: { clientWidth: width, clientHeight: height, pageX, pageY } });
        if (method !== "Page.captureScreenshot") return Promise.reject(new Error(`unexpected ${method}`));
        this.screenshots.push({ quality: params.quality, clip: params.clip });
        if (this.screenshotHangs) return new Promise(() => undefined);
        return Promise.resolve({ data: Buffer.from(JSON.stringify({ id: this.id, content: this.content, scale: params.clip.scale })).toString("base64") });
      },
    };
    constructor() {
      super();
      allContents.set(this.id, this);
    }
    /** A frame of `content` at w x h device pixels, as nativeImage holds it. */
    image(w: number, h: number, content = this.content): FakeImage {
      return {
        isEmpty: () => w === 0,
        getSize: () => ({ width: w, height: h }),
        resize: ({ width: to }) => this.image(to, Math.round((h * to) / w), content),
        toJPEG: (quality) => jpegOf(`${content}@${w}q${quality}`, this.encodedSize(quality, w)),
      };
    }
    setWindowOpenHandler(): void {}
    isDestroyed(): boolean {
      return this.destroyed;
    }
    getURL(): string {
      return this.url;
    }
    getTitle(): string {
      return this.title;
    }
    isLoading(): boolean {
      return this.loading;
    }
    getZoomFactor(): number {
      return 1;
    }
    send(): void {}
    capturePage(...args: unknown[]) {
      this.captures.push(args);
      const { width, height, ratio } = this.viewport;
      if (this.paintHangs) return new Promise(() => undefined);
      return Promise.resolve(this.image(width * ratio, height * ratio));
    }
    loadURL(url: string): Promise<void> {
      this.url = url;
      return Promise.resolve();
    }
    close(): void {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }

  class FakeView {
    static readonly created: FakeView[] = [];
    readonly webContents = new FakeContents();
    constructor() {
      FakeView.created.push(this);
    }
    setBackgroundColor(): void {}
    setBounds(): void {}
    setBorderRadius(): void {}
    setVisible(): void {}
  }

  let ids = 0;
  let focused: FakeWindow | null = null;
  const windows: FakeWindow[] = [];
  class FakeWindow extends FakeEmitter {
    readonly id = ++ids;
    readonly webContents = new FakeContents();
    minimized = false;
    visible = true;
    /** The views on the window, in the order they were put there. */
    readonly children: unknown[] = [];
    readonly contentView = {
      // Adding a view already there moves it to the top, as Electron's does.
      addChildView: (view: unknown) => {
        this.contentView.removeChildView(view);
        this.children.push(view);
      },
      removeChildView: (view: unknown) => {
        if (this.children.includes(view)) this.children.splice(this.children.indexOf(view), 1);
      },
    };
    constructor() {
      super();
      this.webContents.owner = this;
      windows.push(this);
    }
    isDestroyed(): boolean {
      return false;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    isVisible(): boolean {
      return this.visible;
    }
    focus(): void {
      focused = this;
    }
  }

  /** A screenshot's JPEG, decoded: the frame of the page it was taken of, at the scale it was asked for. */
  const nativeImage = {
    createFromBuffer: (buffer: Buffer) => {
      const { id, content, scale } = JSON.parse(buffer.toString()) as { id: number; content: string; scale: number };
      const contents = allContents.get(id)!;
      const { width, height, ratio } = contents.viewport;
      return contents.image(Math.round(width * ratio * scale), Math.round(height * ratio * scale), content);
    },
  };

  return {
    nativeImage,
    FakeView,
    FakeWindow,
    reset: () => {
      windows.length = 0;
      focused = null;
      FakeView.created.length = 0;
    },
    BrowserWindow: {
      fromWebContents: (contents: unknown) => (contents instanceof FakeContents ? contents.owner : null),
      getFocusedWindow: () => focused,
      getAllWindows: () => [...windows],
    },
    session: { fromPartition: () => ({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined, setDevicePermissionHandler: () => undefined, on: () => undefined }) },
  };
});

vi.mock("electron", () => ({ BrowserWindow: fake.BrowserWindow, session: fake.session, WebContentsView: fake.FakeView, nativeImage: fake.nativeImage }));
/** An agent command the test holds in flight: a click waits until `release` is called. */
const agent = vi.hoisted(() => ({ hold: null as Promise<void> | null, log: [] as string[] }));
vi.mock("./browser-command", () => ({
  runBrowserAction: async ({ command, navigate }: { command: { action: string; url?: string }; navigate: (url: string) => Promise<void> }) => {
    agent.log.push(`agent ${command.action}`);
    if (command.action === "click") await agent.hold;
    return command.action === "open" ? navigate(command.url ?? "") : undefined;
  },
}));
const applyInput = vi.hoisted(() => vi.fn(async (_link: unknown, _request: unknown, _late?: AbortSignal): Promise<unknown> => ({ kind: "applied", focus: null })));
vi.mock("./preview-input", () => ({ applyInput, paneLink: (contents: unknown) => ({ contents }) }));

const { closeAllPanes, executeBrowserCommand, installBrowserPane } = await import("./browser-pane");
const { createPreviewHost } = await import("./preview-host");

type FakeWindow = InstanceType<typeof fake.FakeWindow>;
type Contents = InstanceType<typeof fake.FakeView>["webContents"];
type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

const channels = new Map<string, IpcListener>();
const ipc = { handle: (channel: string, listener: IpcListener) => channels.set(channel, listener), on: (channel: string, listener: IpcListener) => channels.set(channel, listener) };
const send = (channel: string, window: FakeWindow, ...args: unknown[]) => channels.get(channel)!({ sender: window.webContents }, ...args);
const rect = { x: 0, y: 0, width: 540, height: 714 };

/** A browser tab painted in `window`, loaded and on screen. Its contents are returned to steer. */
function tab(window: FakeWindow, surface: string, url = "http://127.0.0.1:47831/tick", context?: string): Contents {
  send("browser:show", window, { id: surface, bounds: rect, url, ...(context ? { context } : {}) });
  const contents = paneContents(url);
  contents.emit("did-stop-loading");
  return contents;
}

function paneContents(url: string): Contents {
  const contents = fake.FakeView.created.map((view) => view.webContents).findLast((candidate) => candidate.url === url);
  if (!contents) throw new Error(`no pane loaded ${url}`);
  return contents;
}

const host = () => createPreviewHost();
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");
const frame = (capture: PreviewHostCapture | null) => {
  if (capture?.kind !== "frame") throw new Error(`expected a frame, got ${JSON.stringify(capture)}`);
  return capture;
};

beforeEach(() => {
  channels.clear();
  fake.reset();
  installBrowserPane(ipc as unknown as Electron.IpcMain, { getWindow: () => null });
});

afterEach(() => {
  closeAllPanes();
  vi.useRealTimers();
});

describe("which page a thread's Preview is", () => {
  it("is the tab the agent's browser tool acts on, even while another of its tabs is on screen", async () => {
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    tab(window, "thread:a:tab:2", "http://127.0.0.1:47831/idle");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/tick" });
    paneContents("http://127.0.0.1:47831/tick").title = "QA Tick";
    expect(await host().query("a")).toMatchObject({ url: "http://127.0.0.1:47831/tick", title: "QA Tick" });
  });

  it("follows the tab shown last on the Mac", async () => {
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    tab(window, "thread:a", "http://127.0.0.1:47831/", "thread:a");
    tab(window, "thread:a:tab:2", "http://127.0.0.1:47831/idle", "thread:a");
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/idle");
    send("browser:show", window, { id: "thread:a", bounds: rect, context: "thread:a" });
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/");
  });

  it("without one: the attached pane in the focused window, else any attached pane, else the one shown last", async () => {
    const first = new fake.FakeWindow();
    const second = new fake.FakeWindow();
    tab(first, "thread:a", "http://127.0.0.1:47831/one");
    tab(second, "thread:a", "http://127.0.0.1:47831/two");
    second.focus();
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/two");
    first.focus();
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/one");
    send("browser:hide", first, "thread:a");
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/two");
    send("browser:hide", second, "thread:a");
    send("browser:show", first, { id: "thread:a", bounds: rect });
    send("browser:hide", first, "thread:a");
    expect((await host().query("a"))?.url).toBe("http://127.0.0.1:47831/one");
  });

  it("counts a blank pane that is not loading as closed, and answers nothing for another thread", async () => {
    const window = new fake.FakeWindow();
    send("browser:show", window, { id: "thread:a", bounds: rect });
    expect(await host().query("a")).toBeNull();
    tab(window, "thread:b");
    expect(await host().query("a")).toBeNull();
    expect(await host().query("c")).toBeNull();
  });

  it("names the pane by an opaque id that changes with the tab and never carries the desktop's ids", async () => {
    const window = new fake.FakeWindow();
    tab(window, "thread:a:tab:7");
    const one = (await host().query("a"))!.pane;
    expect(one).toMatch(/^[0-9a-f]{12}$/);
    expect((await host().query("a"))!.pane).toBe(one);
    send("browser:close", window, "thread:a:tab:7");
    tab(window, "thread:a:tab:8", "http://127.0.0.1:47831/idle");
    expect((await host().query("a"))!.pane).not.toBe(one);
  });
});

describe("what the page is doing", () => {
  it("reads loading, the load's error and a crash, which the next load clears", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    contents.title = "QA Tick";
    expect(await host().query("a")).toMatchObject({ title: "QA Tick", loading: false, error: null, crashed: false });
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(await host().query("a")).toMatchObject({ crashed: true });
    contents.emit("did-start-loading");
    expect(await host().query("a")).toMatchObject({ crashed: false, loading: true });
    contents.emit("did-fail-load", {}, -102, "", "http://127.0.0.1:47831/tick", true);
    expect(await host().query("a")).toMatchObject({ error: "Nothing is listening on 127.0.0.1:47831 yet." });
  });
});

describe("capturing a frame", () => {
  it("screenshots the visual viewport through the pane's debugger at its own pixels, and resizes it to the asked width", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    contents.viewport = { width: 540, height: 714, pageX: 0, pageY: 120, ratio: 2 };
    const shot = frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    // A scaled clip would render the page smaller for a frame, on the Mac's screen.
    expect(contents.screenshots).toEqual([{ quality: 90, clip: { x: 0, y: 120, width: 540, height: 714, scale: 1 } }]);
    expect(shot).toMatchObject({ kind: "frame", width: 786, height: 1039, pane: (await host().query("a"))!.pane });
    expect(Buffer.from(shot.jpeg).toString().startsWith("frame-1@786q60")).toBe(true);
    expect(shot.digest).toBe(sha1(shot.jpeg));
    expect(contents.captures).toEqual([]);
  });

  it("is never wider than the pane's own pixels", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const shot = frame(await host().capture("a", { width: 1600, quality: 60, unless: null }));
    expect(contents.screenshots[0]!.clip.scale).toBe(1);
    expect(shot).toMatchObject({ width: 1080, height: 1428 });
  });

  it("answers same when the frame matches the digest the caller holds", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const first = frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(await host().capture("a", { width: 786, quality: 60, unless: first.digest })).toEqual({ kind: "same" });
    contents.content = "frame-2";
    expect(frame(await host().capture("a", { width: 786, quality: 60, unless: first.digest })).digest).not.toBe(first.digest);
  });

  it("encodes a frame over 256 KB again at quality -15, then at three quarters of the width, from one screenshot", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const encoded: [number, number][] = [];
    contents.encodedSize = (quality, width) => {
      encoded.push([quality, width]);
      return quality === 45 && width < 600 ? 200 * 1024 : 300 * 1024;
    };
    const shot = frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(encoded).toEqual([
      [60, 786],
      [45, 786],
      [45, 590],
    ]);
    expect(contents.screenshots).toHaveLength(1);
    expect(shot.jpeg.length).toBeLessThanOrEqual(PREVIEW_FRAME_BYTES);
    expect(shot.width).toBe(590);
  });

  it("captures nothing for a thread without a page, or a view laid out at zero size", async () => {
    const window = new fake.FakeWindow();
    expect(await host().capture("a", { width: 786, quality: 60, unless: null })).toBeNull();
    const contents = tab(window, "thread:a");
    contents.viewport = { ...contents.viewport, width: 0, height: 0 };
    expect(await host().capture("a", { width: 786, quality: 60, unless: null })).toBeNull();
  });

  it("takes a pane off a minimized window so it paints anew, and puts it back as the window is restored", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const view = fake.FakeView.created.find((candidate) => candidate.webContents === contents);
    expect(window.children).toEqual([view]);
    window.minimized = true;
    const first = frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(window.children).toEqual([]);
    contents.content = "frame-2";
    expect(frame(await host().capture("a", { width: 786, quality: 60, unless: first.digest })).digest).not.toBe(first.digest);
    expect(contents.screenshots).toHaveLength(2);
    expect(contents.captures).toEqual([]);
    expect(await host().query("a")).toMatchObject({ url: "http://127.0.0.1:47831/tick", loading: false });
    window.minimized = false;
    window.emit("restore");
    expect(window.children).toEqual([view]);
    window.emit("focus");
    expect(window.children).toEqual([view]);
  });

  it("does the same while the app is hidden, back on the window as it shows or takes focus", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const view = fake.FakeView.created.find((candidate) => candidate.webContents === contents);
    window.visible = false;
    frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(window.children).toEqual([]);
    window.visible = true;
    window.emit("show");
    expect(window.children).toEqual([view]);
    window.visible = false;
    frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    window.visible = true;
    window.emit("focus");
    expect(window.children).toEqual([view]);
  });

  it("leaves a pane the panel hid while its window was away off the window when it comes back", async () => {
    const window = new fake.FakeWindow();
    tab(window, "thread:a");
    window.minimized = true;
    frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    send("browser:hide", window, "thread:a");
    window.minimized = false;
    window.emit("restore");
    expect(window.children).toEqual([]);
    send("browser:show", window, { id: "thread:a", bounds: rect });
    expect(window.children).toHaveLength(1);
  });

  it("keeps a covered window's pane where it is: its screenshot still paints", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(window.children).toHaveLength(1);
    expect(contents.screenshots).toHaveLength(1);
  });

  it("falls back to the last painted frame when the screenshot does not come, and never stacks a second one", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    contents.screenshotHangs = true;
    const waiting = host().capture("a", { width: 786, quality: 60, unless: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frame(await waiting).width).toBe(786);
    expect(contents.captures).toHaveLength(1);
    frame(await host().capture("a", { width: 786, quality: 60, unless: null }));
    expect(contents.screenshots).toHaveLength(1);
    expect(contents.captures).toHaveLength(2);
  });
});

describe("a deleted thread", () => {
  it("closes its panes in every window, each of its tabs and its agent's, and leaves other threads' alone", async () => {
    const first = new fake.FakeWindow();
    const second = new fake.FakeWindow();
    first.focus();
    send("browser:context", first, "thread:a");
    const shown = tab(first, "thread:a", "http://127.0.0.1:47831/");
    const other = tab(first, "thread:a:tab:2", "http://127.0.0.1:47831/idle");
    const elsewhere = tab(second, "thread:a", "http://127.0.0.1:47831/two");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/tick" });
    const kept = tab(first, "thread:b", "http://127.0.0.1:47831/kept");
    host().threadGone("a");
    expect([shown, other, elsewhere].map((contents) => contents.destroyed)).toEqual([true, true, true]);
    expect(await host().query("a")).toBeNull();
    expect(kept.destroyed).toBe(false);
    expect((await host().query("b"))?.url).toBe("http://127.0.0.1:47831/kept");
    await expect(executeBrowserCommand("thread:a", { action: "click", ref: "e1" })).rejects.toThrow("No preview is open for this conversation.");
  });
});

describe("telling the core", () => {
  it("says when a thread's page opens, changes and closes, and which of those change whether it is open", async () => {
    const changes: [string, boolean][] = [];
    const off = host().onChange((threadId, lifecycle) => changes.push([threadId, lifecycle]));
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a:tab:2");
    expect(changes).toContainEqual(["a", true]);
    changes.length = 0;
    contents.title = "Renamed";
    contents.emit("page-title-updated");
    expect(changes).toEqual([["a", false]]);
    changes.length = 0;
    tab(window, "task:t1");
    expect(changes).toEqual([]);
    send("browser:close", window, "thread:a:tab:2");
    expect(changes).toContainEqual(["a", true]);
    off();
    changes.length = 0;
    tab(window, "thread:a");
    expect(changes).toEqual([]);
  });
});

describe("a phone's input", () => {
  const request = (pane: string) => ({ pane, frame: { width: 786, height: 566 }, input: { kind: "tap" as const, x: 393, y: 283, count: 1 } });

  beforeEach(() => {
    applyInput.mockClear();
    agent.log.length = 0;
    agent.hold = null;
  });

  it("lands on the pane the thread shows, and is dropped for a pane it no longer shows", async () => {
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    const first = tab(window, "thread:a", "http://127.0.0.1:47831/", "thread:a");
    const shown = (await host().query("a"))!.pane;
    expect(await host().input("a", request(shown))).toEqual({ kind: "applied", focus: null });
    expect(applyInput).toHaveBeenCalledExactlyOnceWith({ contents: first }, request(shown), expect.any(AbortSignal));
    tab(window, "thread:a:tab:2", "http://127.0.0.1:47831/idle", "thread:a");
    expect(await host().input("a", request(shown))).toEqual({ kind: "refused", reason: "pane" });
    expect(applyInput).toHaveBeenCalledTimes(1);
    expect(await host().input("b", request(shown))).toBeNull();
  });

  it("waits for the agent's command in flight on that pane, then lands; refused once it waited 2 s", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    let release!: () => void;
    agent.hold = new Promise((resolve) => (release = resolve));
    const clicking = executeBrowserCommand("thread:a", { action: "click", ref: "e1" });
    const waited = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applyInput).not.toHaveBeenCalled();
    release();
    await clicking;
    expect(await waited).toEqual({ kind: "applied", focus: null });
    agent.hold = new Promise(() => undefined);
    void executeBrowserCommand("thread:a", { action: "click", ref: "e2" });
    const refused = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await refused).toEqual({ kind: "refused", reason: "busy" });
    expect(applyInput).toHaveBeenCalledTimes(1);
  });

  it("holds the agent's next command until the phone's input in flight has landed", async () => {
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    let land!: () => void;
    applyInput.mockImplementationOnce(() => new Promise((resolve) => (land = () => resolve({ kind: "applied", focus: null }))));
    const typing = host().input("a", request(pane));
    await vi.waitFor(() => expect(applyInput).toHaveBeenCalled());
    agent.log.length = 0;
    const snapshot = executeBrowserCommand("thread:a", { action: "snapshot" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(agent.log).toEqual([]);
    land();
    await typing;
    await snapshot;
    expect(agent.log).toEqual(["agent snapshot"]);
  });

  /** A page that does not take the phone's input until `answer`: its script spins, or a dialog holds it. */
  const stuckPage = () => {
    let answer!: () => void;
    applyInput.mockImplementationOnce(() => new Promise((resolve) => (answer = () => resolve({ kind: "applied", focus: null }))));
    return () => answer();
  };

  it("answers in 2 s that the page is not responding when it has not taken the input, and drops what was not sent", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    stuckPage();
    const tapping = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(applyInput.mock.calls[0]![2]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await tapping).toEqual({ kind: "refused", reason: "stuck" });
    expect(applyInput.mock.calls[0]![2]!.aborted).toBe(true);
  });

  it("keeps the pane until the page has taken what was sent: the agent's next command and the phone's next input wait for it, in turn", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    const answer = stuckPage();
    const first = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toEqual({ kind: "refused", reason: "stuck" });
    agent.log.length = 0;
    const snapshot = executeBrowserCommand("thread:a", { action: "snapshot" });
    const next = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.log).toEqual([]);
    answer();
    await snapshot;
    expect(agent.log).toEqual(["agent snapshot"]);
    expect(await next).toEqual({ kind: "applied", focus: null });
    expect(applyInput).toHaveBeenCalledTimes(2);
  });

  it("refuses an input that waited out one still holding the pane as the page not responding, never blaming the agent", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    stuckPage();
    void host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(100);
    const next = host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await next).toEqual({ kind: "refused", reason: "stuck" });
    expect(applyInput).toHaveBeenCalledTimes(1);
  });

  it("lets the pane go 4 s after a phone's input began however stuck its page, so an agent's command, which waits 5 s, still runs", async () => {
    vi.useFakeTimers();
    const window = new fake.FakeWindow();
    window.focus();
    send("browser:context", window, "thread:a");
    await executeBrowserCommand("thread:a", { action: "open", url: "http://127.0.0.1:47831/buttons" });
    const pane = (await host().query("a"))!.pane;
    stuckPage();
    void host().input("a", request(pane));
    await vi.advanceTimersByTimeAsync(10);
    agent.log.length = 0;
    const snapshot = executeBrowserCommand("thread:a", { action: "snapshot" });
    await vi.advanceTimersByTimeAsync(3_980);
    expect(agent.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    await snapshot;
    expect(agent.log).toEqual(["agent snapshot"]);
  });

  it("is not applied to a pane whose page crashed", async () => {
    const window = new fake.FakeWindow();
    const contents = tab(window, "thread:a");
    const pane = (await host().query("a"))!.pane;
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(await host().input("a", request(pane))).toBeNull();
    expect(applyInput).not.toHaveBeenCalled();
  });
});
