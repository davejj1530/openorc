import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPaneState } from "../shared/types";

/**
 * The module reaches for Electron at import time, and the half of it worth
 * faking is the half that involves a window: which view is attached to which
 * one, what the panel is told, and what a page is allowed to do on the way.
 * These stand-ins carry exactly that surface, so the wiring can be driven end
 * to end without an Electron window in the room.
 */
const fake = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;

  class FakeEmitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      const existing = this.listeners.get(event);
      if (existing) existing.push(listener);
      else this.listeners.set(event, [listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeContents extends FakeEmitter {
    owner: FakeWindow | null = null;
    url = "";
    title = "";
    loading = false;
    destroyed = false;
    reloads = 0;
    readonly loaded: string[] = [];
    readonly sent: { channel: string; payload: unknown }[] = [];
    readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined };
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
    send(channel: string, payload: unknown): void {
      this.sent.push({ channel, payload });
    }
    /** The bytes of the last frame drawn. Empty is what a view that never painted hands back. */
    frame = "pixels";
    capturePage(): Promise<{ isEmpty(): boolean; toJPEG(quality: number): Buffer }> {
      const frame = Buffer.from(this.frame);
      return Promise.resolve({ isEmpty: () => frame.length === 0, toJPEG: () => frame });
    }
    /** Chromium does not promise isLoading has flipped by the time loadURL returns, so this one does not either. */
    loadURL(url: string): Promise<void> {
      this.loaded.push(url);
      return Promise.resolve();
    }
    reload(): void {
      this.reloads += 1;
      this.loading = true;
    }
    close(): void {
      this.destroyed = true;
      this.emit("destroyed");
    }
    /** What Chromium does when a load lands: the URL commits and the pane hears the load stop. */
    finish(): void {
      const last = this.loaded.at(-1);
      if (last !== undefined) this.url = last;
      this.loading = false;
      this.emit("did-stop-loading");
    }
  }

  class FakeView {
    static readonly created: FakeView[] = [];
    readonly webContents = new FakeContents();
    bounds: { x: number; y: number; width: number; height: number } | null = null;
    visible = false;
    background = "";
    constructor(_options?: unknown) {
      FakeView.created.push(this);
    }
    setBackgroundColor(color: string): void {
      this.background = color;
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds;
    }
    setVisible(visible: boolean): void {
      this.visible = visible;
    }
  }

  let ids = 0;

  class FakeWindow extends FakeEmitter {
    readonly id = ++ids;
    readonly webContents = new FakeContents();
    readonly children: FakeView[] = [];
    destroyed = false;
    readonly contentView = {
      addChildView: (view: FakeView): void => {
        const at = this.children.indexOf(view);
        if (at >= 0) this.children.splice(at, 1);
        this.children.push(view);
      },
      removeChildView: (view: FakeView): void => {
        const at = this.children.indexOf(view);
        if (at >= 0) this.children.splice(at, 1);
      },
    };
    constructor() {
      super();
      this.webContents.owner = this;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    close(): void {
      this.destroyed = true;
      this.emit("closed");
    }
  }

  return {
    FakeContents,
    FakeView,
    FakeWindow,
    BrowserWindow: { fromWebContents: (contents: unknown): FakeWindow | null => (contents instanceof FakeContents ? contents.owner : null) },
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        setDevicePermissionHandler: () => undefined,
        on: () => undefined,
      }),
    },
  };
});

vi.mock("electron", () => ({ BrowserWindow: fake.BrowserWindow, session: fake.session, WebContentsView: fake.FakeView }));

const { closeAllPanes, hasBrowserContext, installBrowserPane, isAllowedPaneUrl, loadErrorMessage, toViewBounds, openBrowserLink } = await import("./browser-pane");

type FakeView = InstanceType<typeof fake.FakeView>;
type FakeWindow = InstanceType<typeof fake.FakeWindow>;
type IpcListener = (event: Electron.IpcMainEvent, ...args: unknown[]) => unknown;

/** Both halves of ipcMain the module uses, and a way to speak into them as a given window. */
class FakeIpc {
  private readonly channels = new Map<string, IpcListener>();
  handle(channel: string, listener: IpcListener): void {
    this.channels.set(channel, listener);
  }
  on(channel: string, listener: IpcListener): void {
    this.channels.set(channel, listener);
  }
  call(channel: string, window: FakeWindow, ...args: unknown[]): unknown {
    const listener = this.channels.get(channel);
    if (!listener) throw new Error(`nothing is listening on ${channel}`);
    return listener({ sender: window.webContents } as unknown as Electron.IpcMainEvent, ...args);
  }
}

const panelRect = { x: 0, y: 0, width: 800, height: 600 };

function install(): FakeIpc {
  const ipc = new FakeIpc();
  installBrowserPane(ipc as unknown as Electron.IpcMain, { getWindow: () => null });
  return ipc;
}

function show(ipc: FakeIpc, window: FakeWindow, id: string, url?: string): BrowserPaneState {
  const input = url === undefined ? { id, bounds: panelRect } : { id, bounds: panelRect, url };
  return ipc.call("browser:show", window, input) as BrowserPaneState;
}

/** The view the last show built. Every pane in these tests is created by a show. */
function newestView(): FakeView {
  const view = fake.FakeView.created.at(-1);
  if (!view) throw new Error("no view was created");
  return view;
}

/** The pane state the last push carried, which is the only thing the panel ever sees. */
function lastPush(window: FakeWindow): BrowserPaneState | null {
  const last = window.webContents.sent.at(-1);
  if (!last) return null;
  return (last.payload as { id: string; state: BrowserPaneState }).state;
}

/** A pane on a loaded page, which is where most of these start. */
function loaded(ipc: FakeIpc, window: FakeWindow, id: string, url: string): FakeView {
  show(ipc, window, id, url);
  const view = newestView();
  view.webContents.finish();
  window.webContents.sent.length = 0;
  return view;
}

beforeEach(() => {
  fake.FakeView.created.length = 0;
});

afterEach(() => {
  closeAllPanes();
});

describe("pane URL policy", () => {
  it("allows loopback over http and https, including the .localhost tree", () => {
    for (const url of [
      "http://localhost:3000",
      "http://localhost:5173/app?tab=1#top",
      "https://localhost/",
      "HTTP://LOCALHOST:3000/",
      "http://127.0.0.1:8080/index.html",
      "https://127.0.0.1",
      "http://[::1]:4200/",
      "http://app.localhost:3000/",
      "https://docs.preview.localhost/",
      "about:blank",
    ])
      expect(isAllowedPaneUrl(url), url).toBe(true);
  });

  it("allows the forms a resolver reads as loopback and the parser writes differently", () => {
    // The root dot is what a fully qualified name carries, and the parser
    // collapses an IPv4-mapped address on the way in. All three address the
    // loopback interface and all three used to be refused.
    for (const url of ["http://localhost./", "http://app.localhost./", "http://[::ffff:127.0.0.1]/", "http://[::ffff:127.0.0.1]:5173/app"]) {
      expect(isAllowedPaneUrl(url), url).toBe(true);
    }
  });

  it("allows public domains, LAN addresses and other valid HTTP(S) hosts", () => {
    for (const url of [
      "http://example.com",
      "https://example.com/docs?tab=1#top",
      "HTTPS://EXAMPLE.COM/",
      "https://localhost.example.com/",
      "http://notlocalhost:3000",
      "http://127.0.0.2:3000",
      "http://0.0.0.0:3000",
      "http://192.168.1.10:3000",
      "http://[::2]:3000",
      "http://[::ffff:127.0.0.2]/",
      "http://example.com/?next=http://localhost:3000",
      "http://example.com/#localhost",
    ])
      expect(isAllowedPaneUrl(url), url).toBe(true);
  });

  it("refuses embedded credentials for local and public hosts", () => {
    for (const url of ["http://localhost@evil.com", "http://localhost@example.com/", "http://user:pass@localhost:3000/", "https://user:pass@example.com/", "https://:pass@example.com/"])
      expect(isAllowedPaneUrl(url), url).toBe(false);
  });

  it("refuses every scheme but http and https, about:blank aside", () => {
    for (const url of [
      "file:///etc/passwd",
      "file://localhost/etc/passwd",
      "about:config",
      "about:blank?x=1",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "openorc-asset://attachments/secret.png",
      "ws://localhost:3000",
      "blob:http://localhost:3000/abc",
    ])
      expect(isAllowedPaneUrl(url), url).toBe(false);
  });

  it("refuses anything that is not a URL at all", () => {
    for (const url of ["", " ", "localhost:3000", "//localhost:3000", "/app", "not a url"]) {
      expect(isAllowedPaneUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe("pane bounds", () => {
  it("falls back to zoom 1 when the factor is missing or nonsense", () => {
    const expected = { x: 10, y: 20, width: 100, height: 50 };
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toViewBounds({ x: 10, y: 20, width: 100, height: 50 }, zoom), String(zoom)).toEqual(expected);
    }
  });

  it("never hands Chromium a non-finite or negative size", () => {
    expect(toViewBounds({ x: Number.NaN, y: 10, width: 100, height: Number.POSITIVE_INFINITY }, 1)).toEqual({ x: 0, y: 10, width: 100, height: 0 });
    expect(toViewBounds({ x: 5, y: 5, width: -40, height: -1 }, 1)).toEqual({ x: 5, y: 5, width: 0, height: 0 });
  });
});

describe("load errors", () => {
  it("names the host rather than the error code for the failures a dev server causes", () => {
    expect(loadErrorMessage(-102, "ERR_CONNECTION_REFUSED", "http://localhost:5173/")).toBe("Nothing is listening on localhost:5173 yet.");
    expect(loadErrorMessage(-105, "ERR_NAME_NOT_RESOLVED", "http://app.localhost/")).toBe("Could not resolve app.localhost.");
    expect(loadErrorMessage(-7, "ERR_TIMED_OUT", "http://127.0.0.1:9000/")).toBe("127.0.0.1:9000 did not answer in time.");
    expect(loadErrorMessage(-501, "ERR_INSECURE_RESPONSE", "https://localhost:8443/")).toBe("localhost:8443 served a certificate this pane will not accept.");
  });

  it("keeps Chromium's own words for anything unmapped, and says something when there are none", () => {
    expect(loadErrorMessage(-355, "ERR_HTTP_RESPONSE_CODE_FAILURE", "http://localhost:3000/")).toBe("ERR_HTTP_RESPONSE_CODE_FAILURE (-355).");
    expect(loadErrorMessage(-9999, "", "http://localhost:3000/")).toBe("The page failed to load (-9999).");
  });

  it("echoes an unparseable URL instead of printing an empty host", () => {
    expect(loadErrorMessage(-102, "ERR_CONNECTION_REFUSED", "not a url")).toBe("Nothing is listening on not a url yet.");
  });
});

describe("compositing the view", () => {
  it("holds the view off the window until the page has painted, reporting the load as running meanwhile", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    const state = show(ipc, window, "thread-1", "http://localhost:5173/");
    const view = newestView();

    expect(window.children).not.toContain(view);
    // Nothing is composited over the panel's rectangle yet, so the panel has
    // to have something to draw into it.
    expect(state.loading).toBe(true);
    view.webContents.finish();
    expect(window.children).toContain(view);
    expect(view.visible).toBe(true);
    expect(lastPush(window)?.loading).toBe(false);
  });

  it("does not tear an attached view off the window for the next navigation", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    const view = loaded(ipc, window, "thread-1", "http://localhost:5173/");
    view.webContents.emit("did-start-loading");
    expect(window.children).toContain(view);
  });
});

describe("a still for a floating layer", () => {
  const capture = (ipc: FakeIpc, window: FakeWindow, id: string) => ipc.call("browser:capture", window, id) as Promise<string | null>;

  it("captures the page on screen as a JPEG the panel can paint", async () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    loaded(ipc, window, "thread-1", "http://localhost:5173/");
    expect(await capture(ipc, window, "thread-1")).toBe(`data:image/jpeg;base64,${Buffer.from("pixels").toString("base64")}`);
  });

  it("captures nothing for a view that is off screen, still loading, or has never drawn", async () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    show(ipc, window, "thread-1", "http://localhost:5173/");
    const view = newestView();
    expect(await capture(ipc, window, "thread-1")).toBeNull();

    view.webContents.finish();
    ipc.call("browser:hide", window, "thread-1");
    expect(await capture(ipc, window, "thread-1")).toBeNull();

    show(ipc, window, "thread-1");
    view.webContents.frame = "";
    expect(await capture(ipc, window, "thread-1")).toBeNull();
  });

  it("captures nothing for a pane another window is painting", async () => {
    const ipc = install();
    loaded(ipc, new fake.FakeWindow(), "thread-1", "http://localhost:5173/");
    expect(await capture(ipc, new fake.FakeWindow(), "thread-1")).toBeNull();
  });
});

describe("website navigation policy", () => {
  const cases = ["will-frame-navigate", "will-redirect"] as const;

  it("rejects unsafe addresses from the panel and address field", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    const state = show(ipc, window, "thread-1", "file:///etc/passwd");
    const view = newestView();
    expect(state.error).toBe("Use an HTTP or HTTPS website URL without embedded credentials.");
    expect(view.webContents.loaded).toEqual([]);

    ipc.call("browser:navigate", window, "thread-1", "https://user:secret@example.com/");
    expect(lastPush(window)?.error).toBe(state.error);
    expect(view.webContents.loaded).toEqual([]);
  });

  for (const event of cases) {
    for (const isMainFrame of [true, false]) {
      it(`allows a public website on ${event} in the ${isMainFrame ? "main frame" : "subframe"}`, () => {
        const ipc = install();
        const window = new fake.FakeWindow();
        const view = loaded(ipc, window, "thread-1", "http://localhost:5173/");
        const preventDefault = vi.fn();

        view.webContents.emit(event, { url: "https://example.com/", isMainFrame, preventDefault });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(lastPush(window)).toBeNull();
        expect(window.children).toContain(view);
      });
    }

    it(`stops a subframe on ${event} without reporting it as the pane's failure`, () => {
      const ipc = install();
      const window = new fake.FakeWindow();
      const view = loaded(ipc, window, "thread-1", "http://localhost:5173/");

      let prevented = 0;
      view.webContents.emit(event, {
        url: "file:///etc/passwd",
        isMainFrame: false,
        preventDefault: () => {
          prevented += 1;
        },
      });

      expect(prevented).toBe(1);
      expect(lastPush(window)).toBeNull();
      expect(window.children).toContain(view);
    });

    it(`stops the main frame on ${event} and says so`, () => {
      const ipc = install();
      const window = new fake.FakeWindow();
      const view = loaded(ipc, window, "thread-1", "http://localhost:5173/");

      let prevented = 0;
      view.webContents.emit(event, {
        url: "openorc-asset://attachments/secret.png",
        isMainFrame: true,
        preventDefault: () => {
          prevented += 1;
        },
      });

      expect(prevented).toBe(1);
      expect(lastPush(window)?.error).toBe("Use an HTTP or HTTPS website URL without embedded credentials.");
    });
  }
});

describe("one pane per window", () => {
  it("ignores bounds and hide sent from a window that is not painting the pane", () => {
    const ipc = install();
    const painting = new fake.FakeWindow();
    const other = new fake.FakeWindow();
    const view = loaded(ipc, painting, "thread-1", "http://localhost:5173/");
    const placed = view.bounds;

    ipc.call("browser:setBounds", other, "thread-1", { x: 10, y: 10, width: 20, height: 20 });
    ipc.call("browser:hide", other, "thread-1");

    expect(view.bounds).toEqual(placed);
    expect(painting.children).toContain(view);
  });

  it("gives a second window on the same thread a pane of its own rather than stealing the first", () => {
    const ipc = install();
    const first = new fake.FakeWindow();
    const second = new fake.FakeWindow();
    const firstView = loaded(ipc, first, "thread-1", "http://localhost:5173/");
    const secondView = loaded(ipc, second, "thread-1", "http://localhost:5173/");

    expect(secondView).not.toBe(firstView);
    expect(first.children).toContain(firstView);
    expect(second.children).toContain(secondView);
  });

  it("closes the panes of a window that closes, and no others", () => {
    const ipc = install();
    const closing = new fake.FakeWindow();
    const staying = new fake.FakeWindow();
    const going = loaded(ipc, closing, "thread-1", "http://localhost:5173/");
    const kept = loaded(ipc, staying, "thread-1", "http://localhost:5173/");

    closing.close();

    expect(going.webContents.destroyed).toBe(true);
    expect(kept.webContents.destroyed).toBe(false);
  });
});

describe("a window that reloads", () => {
  it("takes its panes off the window, keeps their pages, and forgets the panel that went with the old page", () => {
    const ipc = install();
    const reloading = new fake.FakeWindow();
    const other = new fake.FakeWindow();
    ipc.call("browser:context", reloading, "thread-1");
    const view = loaded(ipc, reloading, "thread-1", "http://localhost:5173/");
    const kept = loaded(ipc, other, "thread-1", "http://localhost:5173/");

    // A reload runs no React cleanup, so this is all main hears of the panel going.
    reloading.webContents.emit("did-navigate");

    expect(reloading.children).toEqual([]);
    expect(view.visible).toBe(false);
    expect(other.children).toContain(kept);
    expect(hasBrowserContext(reloading as unknown as Electron.BrowserWindow)).toBe(false);

    // The new page opens the panel again and gets the same page back, not a fresh load of it.
    show(ipc, reloading, "thread-1", "http://localhost:5173/");
    expect(reloading.children).toContain(view);
    expect(view.webContents.loaded).toEqual(["http://localhost:5173/"]);
  });
});

describe("opening thread links", () => {
  it("uses the sender's context and ignores unsupported or credential-bearing links", () => {
    const ipc = install();
    const first = new fake.FakeWindow();
    const second = new fake.FakeWindow();
    ipc.call("browser:context", first, "thread:a");
    for (const url of ["file:///tmp/secret", "javascript:alert(1)", "https://u:p@example.com", "about:blank"]) openBrowserLink(first as unknown as Electron.BrowserWindow, url);
    openBrowserLink(second as unknown as Electron.BrowserWindow, "https://example.com/");
    expect(fake.FakeView.created).toHaveLength(0);
    ipc.call("browser:context", second, "thread:b");
    openBrowserLink(second as unknown as Electron.BrowserWindow, "https://example.com/");
    expect(second.webContents.sent.at(-1)?.payload).toBe("thread:b");
    expect(first.webContents.sent).toHaveLength(0);
  });

  it("retries a failed link when reopening instead of replacing it with the previous default", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    ipc.call("browser:context", window, "thread:a");
    openBrowserLink(window as unknown as Electron.BrowserWindow, "https://example.com/failed");
    const view = newestView();
    view.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "https://example.com/failed", true);
    show(ipc, window, "thread:a", "http://localhost:3000");
    expect(view.webContents.loaded).toEqual(["https://example.com/failed", "https://example.com/failed"]);
  });
});

describe("reopening a pane", () => {
  it("keeps the page the user navigated to when the panel reasserts its default URL", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    const view = loaded(ipc, window, "thread-1", "http://localhost:5173/");
    ipc.call("browser:navigate", window, "thread-1", "http://localhost:5173/settings");
    view.webContents.finish();

    ipc.call("browser:hide", window, "thread-1");
    show(ipc, window, "thread-1", "http://localhost:5173/");

    expect(view.webContents.loaded).toEqual(["http://localhost:5173/", "http://localhost:5173/settings"]);
    expect(view.webContents.url).toBe("http://localhost:5173/settings");
  });

  it("retries the URL when the last attempt never landed a page", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    show(ipc, window, "thread-1", "http://localhost:5173/");
    const view = newestView();
    view.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", "http://localhost:5173/", true);

    ipc.call("browser:hide", window, "thread-1");
    show(ipc, window, "thread-1", "http://localhost:5173/");

    expect(view.webContents.loaded).toEqual(["http://localhost:5173/", "http://localhost:5173/"]);
  });
});

describe("evicting panes", () => {
  /** The cap the module keeps. A seventh pane has to cost one of the six. */
  const cap = 6;

  function fill(ipc: FakeIpc, window: FakeWindow, count: number, from = 1): FakeView[] {
    const views: FakeView[] = [];
    for (let n = from; n < from + count; n += 1) {
      const view = loaded(ipc, window, `thread-${n}`, `http://localhost:5173/${n}`);
      ipc.call("browser:hide", window, `thread-${n}`);
      views.push(view);
    }
    return views;
  }

  it("keeps a pane revealed again out of the way of the cap", () => {
    const ipc = install();
    const window = new fake.FakeWindow();
    const views = fill(ipc, window, cap);
    // The oldest pane by creation, shown again and hidden again: the cap goes
    // by when a pane was last looked at, not by when it was built.
    show(ipc, window, "thread-1", "http://localhost:5173/1");
    ipc.call("browser:hide", window, "thread-1");
    fill(ipc, window, 1, cap + 1);

    expect(views[0]?.webContents.destroyed).toBe(false);
    expect(views[1]?.webContents.destroyed).toBe(true);
  });
});
