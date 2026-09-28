import { BrowserWindow, session, WebContentsView } from "electron";
import type { BrowserPaneState, PaneRect } from "../shared/types";
import type { BrowserCommand, BrowserResult } from "@openorc/protocol";
import { runBrowserAction } from "./browser-command";

/**
 * The single gate. Every URL passes through it: the one the panel opens with,
 * the one typed into the field, the one a link inside the page asks for, and
 * the one a server hands back as a redirect. It is pure so the policy can be
 * read in one screen and tested without an Electron window in the room.
 */
export function isAllowedPaneUrl(url: string): boolean {
  // The pane opens on about:blank and returns there when it is emptied. No
  // other about: URL is a page, and several of them are Chromium's internals.
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Allow any web host. Keep credentials out of addresses that are shown in
  // the panel and returned to agents; sites can use their normal login pages.
  return parsed.username === "" && parsed.password === "";
}

const orZero = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * A rectangle the renderer measured in CSS pixels, in the device-independent
 * pixels the view is laid out in. Chromium's zoom factor is the whole
 * difference, and because the view is composited beside the page rather than
 * inside it, nothing else applies that factor on the way.
 *
 * Both edges are rounded before the size is taken from them. Rounding the
 * origin and the size independently lets the far edge land half a pixel out,
 * and the pane then shimmers against the panel's border for the length of a
 * drag. Values arrive over IPC, so a non-finite number reads as zero instead
 * of reaching Chromium.
 */
export function toViewBounds(rect: PaneRect, zoom: number): Electron.Rectangle {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x = orZero(rect.x) * scale;
  const y = orZero(rect.y) * scale;
  const left = Math.round(x);
  const top = Math.round(y);
  const right = Math.round(x + Math.max(0, orZero(rect.width)) * scale);
  const bottom = Math.round(y + Math.max(0, orZero(rect.height)) * scale);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Chromium's net error codes in the words of someone looking at an empty
 * panel. Connection refused is the one that happens daily: the dev server the
 * agent was told to start is not up yet, and saying so is the difference
 * between a pane and a grey rectangle. An unmapped code keeps Chromium's own
 * description, which is still more use than "something went wrong".
 */
export function loadErrorMessage(errorCode: number, errorDescription: string, url: string): string {
  const where = hostOf(url);
  switch (errorCode) {
    case -102:
      return `Nothing is listening on ${where} yet.`;
    case -105:
      return `Could not resolve ${where}.`;
    case -7:
      return `${where} did not answer in time.`;
    case -100:
    case -324:
      return `${where} closed the connection without answering.`;
    case -501:
      return `${where} served a certificate this pane will not accept.`;
    default:
      return `${errorDescription || "The page failed to load"} (${errorCode}).`;
  }
}

const websiteUrlRequired = "Use an HTTP or HTTPS website URL without embedded credentials.";

const partition = "persist:openorc-preview";
let previewSession: Electron.Session | null = null;

/**
 * A session of the pane's own, built once. The default session serves
 * openorc-asset:// as a privileged scheme and holds the app's cookies and
 * storage; a page an agent wrote thirty seconds ago has no business sharing
 * either. Persistent rather than in-memory, because signing back into the app
 * under test on every launch is the friction that gets a pane closed for good.
 *
 * Nothing in a preview is worth a prompt, so every permission is refused
 * outright, and a download would write to disk on behalf of a page the user
 * only meant to look at.
 */
function paneSession(): Electron.Session {
  if (previewSession) return previewSession;
  const created = session.fromPartition(partition);
  created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.setPermissionCheckHandler(() => false);
  created.setDevicePermissionHandler(() => false);
  created.on("will-download", (event) => event.preventDefault());
  previewSession = created;
  return created;
}

interface Pane {
  agentBusy?: boolean;
  revealRequested?: boolean;
  view: WebContentsView;
  /** The window painting this pane. A pane never moves: another window gets one of its own. */
  window: BrowserWindow;
  /** The id the panel knows this pane by. The map key carries the window as well. */
  surface: string;
  /** The panel wants this pane on screen. Attaching it can lag that while a page is still coming. */
  desired: boolean;
  attached: boolean;
  /** A load is in flight and nothing has painted yet, so there is nothing worth compositing. */
  pending: boolean;
  error: string | null;
  /** The last URL this pane was told to open, so a failed load still has a name to report. */
  requested: string;
  /**
   * Reveal order, for eviction. A counter and not a clock: only the order
   * matters, and two reveals inside the same millisecond would tie.
   */
  shown: number;
}

const panes = new Map<string, Pane>();
const contexts = new Map<BrowserWindow, string>();
const agentPanes = new Map<string, Pane>();
let reveals = 0;
/** Windows already carrying a teardown listener, so reopening a pane does not stack another. */
const watchedWindows = new WeakSet<BrowserWindow>();

/**
 * A pane belongs to one window. The panel names a surface, and the same
 * surface is open twice the moment someone opens a second window on a thread,
 * so the window is part of the identity. Without it the second window's
 * setBounds drags the first window's view across the screen and its hide
 * blanks it. The key is derived from the sender on every message, which is
 * also what keeps one window from reaching into another's pane at all.
 */
const paneKey = (window: BrowserWindow, surface: string): string => `${window.id}:${surface}`;

/**
 * Six. A pane is a live renderer process holding a dev server's page open, and
 * the panel only ever hides them, so without a cap a day of moving between
 * threads leaves one alive per thread visited. Six is more than the handful
 * anyone alternates between in a sitting, which is the point: the cap should
 * only ever reach a pane nobody has looked at in a long while.
 */
const paneLimit = 6;

function readState(pane: Pane): BrowserPaneState {
  const contents = pane.view.webContents;
  if (contents.isDestroyed()) {
    return { url: pane.requested, title: "", canGoBack: false, canGoForward: false, loading: false, error: pane.error ?? "The preview stopped." };
  }
  return {
    // A load that failed leaves no URL behind, and the field must still show
    // what the user asked for rather than emptying itself under them.
    url: contents.getURL() || pane.requested,
    title: contents.getTitle(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    // Chromium has its own idea of when a load starts, and the view is held
    // off the window from the moment loadURL is called. The panel draws that
    // gap, so the gap has to read as loading or the panel draws nothing into
    // a rectangle with nothing composited over it.
    loading: contents.isLoading() || pane.pending,
    error: pane.error,
  };
}

function publish(pane: Pane): void {
  if (pane.window.isDestroyed()) return;
  pane.window.webContents.send("browser:state", { id: pane.surface, state: readState(pane) });
}

function attach(pane: Pane): void {
  if (pane.attached || pane.window.isDestroyed()) return;
  // addChildView reorders an existing child to the top, which is what a
  // reveal wants, so the same call covers first show and every show after.
  pane.window.contentView.addChildView(pane.view);
  pane.view.setVisible(true);
  pane.attached = true;
}

function detach(pane: Pane): void {
  if (!pane.attached) return;
  pane.attached = false;
  // A closing window takes its child views down with it, and the view is not
  // safe to touch after that. The window is the thing to ask, because the
  // view has no isDestroyed of its own.
  if (pane.window.isDestroyed()) return;
  pane.view.setVisible(false);
  pane.window.contentView.removeChildView(pane.view);
}

/**
 * Put the view on screen once there is a page to see. The panel draws the
 * loading line and the failure message into the very rectangle the view is
 * composited over, so a view attached while the page is still coming covers
 * that copy with an empty rectangle. A pane already on screen stays there:
 * Chromium keeps painting the current page until the next one commits, and
 * tearing the view off for every navigation would be the worse flicker.
 */
function settle(pane: Pane): void {
  if (!pane.desired || pane.attached || pane.pending || pane.error !== null) return;
  attach(pane);
}

function destroy(key: string, pane: Pane): void {
  if (agentPanes.get(pane.surface) === pane) agentPanes.delete(pane.surface);
  panes.delete(key);
  pane.desired = false;
  detach(pane);
  if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close();
}

/**
 * Close panes past the cap, oldest reveal first. A pane on screen is one
 * somebody is looking at, in this window or in another, so it is passed over
 * however long ago it was revealed; the cap is not worth blanking a pane in
 * front of a user. The map is left over the cap when there is nothing else to
 * take, which means more panes on screen at once than the cap allows.
 */
function evict(keep?: Pane): void {
  while (panes.size > paneLimit) {
    let oldest: { key: string; pane: Pane } | null = null;
    for (const [key, pane] of panes) {
      if (pane.attached || pane.agentBusy || pane === keep) continue;
      if (oldest === null || pane.shown < oldest.pane.shown) oldest = { key, pane };
    }
    if (oldest === null) return;
    destroy(oldest.key, oldest.pane);
  }
}

/**
 * Closing a window takes its child views with it. Without this the map would
 * keep handing out panes whose WebContents are already gone. Guarded, because
 * a window paints many panes over its life and each one arrives here.
 */
function watch(window: BrowserWindow): void {
  if (watchedWindows.has(window)) return;
  watchedWindows.add(window);
  window.on("closed", () => {
    contexts.delete(window);
    for (const [key, pane] of [...panes]) if (pane.window === window) destroy(key, pane);
  });
}

/**
 * loadURL rejects on any failed navigation, and the failure this pane exists
 * to survive is a dev server that is not up yet. did-fail-load already turns
 * that into something the panel can read, so the rejection is swallowed here
 * rather than left to crash out of the main process as unhandled.
 */
function load(pane: Pane, url: string): void {
  pane.pending = true;
  void pane.view.webContents.loadURL(url).catch(() => undefined);
}

function create(key: string, surface: string, window: BrowserWindow): Pane {
  const view = new WebContentsView({
    webPreferences: {
      // No preload key at all: the guest gets no bridge, and the rest states
      // the sandbox explicitly rather than trusting the defaults to hold.
      session: paneSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // A page that can raise a modal dialog can hold the whole app still;
      // safeDialogs gives the user a way to shut a loop of them up.
      safeDialogs: true,
      spellcheck: false,
    },
  });
  // Opaque, and white because white is what a page that sets no background of
  // its own is. A transparent view composites that page over the app's chrome
  // instead, so a dev server styling nothing but its text reads as a preview
  // painted across the thread list. The panel keeps its loading and error copy
  // to itself by staying detached until there is a page, not by showing
  // through one.
  view.setBackgroundColor("#ffffff");

  const pane: Pane = { view, window, surface, desired: false, attached: false, pending: false, error: null, requested: "about:blank", shown: ++reveals };
  const contents = view.webContents;

  // A preview has no second window to open into, and the window it would get
  // is a Chromium window this app never configured.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());

  // loadURL does not raise these, which is why navigate() checks the policy
  // itself; these two cover the link the page follows and the redirect the
  // server answers with, in the main frame and in every subframe.
  const refuse = (): void => {
    pane.error = websiteUrlRequired;
    publish(pane);
  };
  // Apply the URL policy to every frame, but only a main-frame refusal should
  // replace the page with an error. A rejected embedded frame can stay empty.
  contents.on("will-frame-navigate", (details) => {
    if (isAllowedPaneUrl(details.url)) return;
    details.preventDefault();
    if (details.isMainFrame) refuse();
  });
  contents.on("will-redirect", (details) => {
    if (isAllowedPaneUrl(details.url)) return;
    details.preventDefault();
    if (details.isMainFrame) refuse();
  });

  contents.on("did-start-loading", () => {
    pane.error = null;
    pane.pending = true;
    publish(pane);
  });
  contents.on("did-stop-loading", () => {
    pane.pending = false;
    settle(pane);
    publish(pane);
  });
  contents.on("did-navigate", () => publish(pane));
  contents.on("did-navigate-in-page", () => publish(pane));
  contents.on("page-title-updated", () => publish(pane));
  contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which is what a load cancelled by the next one looks
    // like. Reporting it would flash an error on every fast retype.
    if (!isMainFrame || errorCode === -3) return;
    pane.error = loadErrorMessage(errorCode, errorDescription, validatedURL || pane.requested);
    publish(pane);
  });
  contents.on("render-process-gone", (_event, details) => {
    pane.error = `The preview stopped (${details.reason}). Reload to start it again.`;
    publish(pane);
  });
  contents.on("destroyed", () => {
    if (panes.get(key) === pane) panes.delete(key);
  });

  watch(window);
  panes.set(key, pane);
  evict(pane);
  return pane;
}

function toRect(value: unknown): PaneRect | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return null;
  return { x, y, width, height };
}

function toId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

/** A pane of this window's that is still alive, or nothing. A destroyed WebContents throws on every call. */
function lookup(window: BrowserWindow, id: unknown): { key: string; pane: Pane } | null {
  const surface = toId(id);
  if (surface === null) return null;
  const key = paneKey(window, surface);
  const pane = panes.get(key);
  if (!pane) return null;
  if (pane.view.webContents.isDestroyed()) {
    panes.delete(key);
    return null;
  }
  return { key, pane };
}

const blankState = (error: string | null): BrowserPaneState => ({ url: "about:blank", title: "", canGoBack: false, canGoForward: false, loading: false, error });

export function hasBrowserContext(window: BrowserWindow): boolean {
  return contexts.has(window);
}

/** The explicit link gesture replaces the page even when Preview already exists. */
export function openBrowserLink(window: BrowserWindow, url: string): boolean {
  const surface = contexts.get(window);
  if (!surface || window.isDestroyed() || url === "about:blank" || !isAllowedPaneUrl(url)) return false;
  const pane = lookup(window, surface)?.pane ?? create(paneKey(window, surface), surface, window);
  pane.requested = url;
  pane.error = null;
  pane.revealRequested = true;
  pane.shown = ++reveals;
  load(pane, url);
  publish(pane);
  window.webContents.send("browser:reveal", surface);
  return true;
}

/**
 * The main half of BrowserPaneApi. The renderer owns where the pane is painted
 * and when it disappears, because the view is composited above the page: it
 * does not clip to the panel, it ignores `inert`, and no CSS the panel writes
 * can move it.
 */
export function installBrowserPane(ipcMain: Electron.IpcMain, options: { getWindow: () => Electron.BrowserWindow | null }): void {
  const windowFor = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null => {
    // A second window has its own sender; getWindow is the fallback for a
    // caller that has none, not the first answer.
    const own = BrowserWindow.fromWebContents(event.sender);
    const window = own ?? options.getWindow();
    return window && !window.isDestroyed() ? window : null;
  };

  /** The pane the sender is allowed to touch: its own window's, or nothing. */
  const senders = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, id: unknown): Pane | null => {
    const window = windowFor(event);
    return window ? (lookup(window, id)?.pane ?? null) : null;
  };

  ipcMain.on("browser:context", (event, id: unknown) => {
    const window = windowFor(event);
    if (!window) return;
    const surface = toId(id);
    if (!surface) {
      contexts.delete(window);
      return;
    }
    contexts.set(window, surface);
    watch(window);
    const pane = lookup(window, surface)?.pane;
    if (pane?.revealRequested) window.webContents.send("browser:reveal", surface);
  });

  ipcMain.handle("browser:show", (event, raw: unknown): BrowserPaneState => {
    if (typeof raw !== "object" || raw === null) return blankState("The panel asked for a preview without an id.");
    const { id, bounds, url } = raw as Record<string, unknown>;
    const surface = toId(id);
    const rect = toRect(bounds);
    if (surface === null || rect === null) return blankState("The panel asked for a preview without an id or a rectangle.");
    const window = windowFor(event);
    if (!window) return blankState("No window is available to paint the preview into.");

    const existing = lookup(window, surface)?.pane ?? null;
    const pane = existing ?? create(paneKey(window, surface), surface, window);
    pane.desired = true;
    pane.revealRequested = false;
    pane.shown = ++reveals;
    pane.view.setBounds(toViewBounds(rect, event.sender.getZoomFactor()));

    // A pane that was only hidden keeps the page the user browsed to. The
    // panel re-asserts the surface's default URL on every reveal, so honouring
    // the argument whenever it differs would throw that page away on the way
    // back from another tab. A pane with nothing in it yet is the only one the
    // argument is news to.
    // A failed link retries its own URL, never an older renderer default.
    const wanted = revealedUrl(Boolean(existing), pane.requested, url);
    const fresh = existing === null || (pane.view.webContents.getURL() === "" && (!pane.pending || pane.error !== null));
    if (wanted !== null && fresh) {
      pane.requested = wanted;
      if (isAllowedPaneUrl(wanted)) {
        pane.error = null;
        load(pane, wanted);
      } else {
        pane.error = websiteUrlRequired;
      }
    }
    settle(pane);
    return readState(pane);
  });

  ipcMain.on("browser:setBounds", (event, id: unknown, bounds: unknown) => {
    const pane = senders(event, id);
    const rect = toRect(bounds);
    if (!pane || !rect) return;
    pane.view.setBounds(toViewBounds(rect, event.sender.getZoomFactor()));
  });

  ipcMain.on("browser:hide", (event, id: unknown) => {
    const pane = senders(event, id);
    if (!pane) return;
    pane.desired = false;
    detach(pane);
  });

  // The still the panel paints in the view's place while a dialog or menu is
  // open over it. JPEG because the encode runs on this thread: PNG takes 40 to
  // 80 ms for a Retina-sized panel, JPEG under 15, and at that density the
  // two cannot be told apart.
  ipcMain.handle("browser:capture", async (event, id: unknown): Promise<string | null> => {
    const pane = senders(event, id);
    // A pane off screen has no frame worth standing in for it.
    if (!pane?.attached) return null;
    const image = await pane.view.webContents.capturePage();
    return image.isEmpty() ? null : `data:image/jpeg;base64,${image.toJPEG(90).toString("base64")}`;
  });

  ipcMain.on("browser:navigate", (event, id: unknown, url: unknown) => {
    const pane = senders(event, id);
    if (!pane || typeof url !== "string") return;
    pane.requested = url;
    if (!isAllowedPaneUrl(url)) {
      pane.error = websiteUrlRequired;
      publish(pane);
      return;
    }
    pane.error = null;
    load(pane, url);
  });

  ipcMain.on("browser:goBack", (event, id: unknown) => {
    const pane = senders(event, id);
    if (pane?.view.webContents.navigationHistory.canGoBack()) pane.view.webContents.navigationHistory.goBack();
  });

  ipcMain.on("browser:goForward", (event, id: unknown) => {
    const pane = senders(event, id);
    if (pane?.view.webContents.navigationHistory.canGoForward()) pane.view.webContents.navigationHistory.goForward();
  });

  ipcMain.on("browser:reload", (event, id: unknown) => {
    const pane = senders(event, id);
    if (!pane) return;
    pane.error = null;
    // A pane that never got a page has nothing to reload; retrying the URL it
    // was given is what the button means there.
    if (pane.view.webContents.getURL() === "" && isAllowedPaneUrl(pane.requested)) load(pane, pane.requested);
    else pane.view.webContents.reload();
    publish(pane);
  });

  ipcMain.on("browser:close", (event, id: unknown) => {
    const window = windowFor(event);
    const found = window ? lookup(window, id) : null;
    if (found) destroy(found.key, found.pane);
  });
}

/** Every pane, gone. Quitting runs this so no page outlives the window it was painted into. */
export function closeAllPanes(): void {
  for (const [key, pane] of [...panes]) destroy(key, pane);
  contexts.clear();
  agentPanes.clear();
}

/** Resolve only an authenticated conversation surface, never an arbitrary WebContents. */
export async function executeBrowserCommand(surface: string, command: BrowserCommand): Promise<BrowserResult> {
  if (command.action === "open" && (!isAllowedPaneUrl(command.url) || command.url === "about:blank")) throw new Error(websiteUrlRequired);
  let pane = agentPanes.get(surface);
  if (pane?.view.webContents.isDestroyed() || pane?.window.isDestroyed()) {
    agentPanes.delete(surface);
    pane = undefined;
  }
  if (!pane) {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    const focused = BrowserWindow.getFocusedWindow();
    const candidates = [...panes.values()].filter((candidate) => candidate.surface === surface && !candidate.view.webContents.isDestroyed() && !candidate.window.isDestroyed());
    pane = candidates.find((candidate) => candidate.attached && candidate.window === focused) ?? candidates.find((candidate) => candidate.attached) ?? candidates[0];
    if (!pane) {
      if (command.action !== "open") throw new Error("No preview is open for this conversation. Use browser action=open with a website URL first.");
      const window = windows.find((window) => window === focused && contexts.get(window) === surface) ?? windows.find((window) => contexts.get(window) === surface) ?? windows[0];
      if (!window) throw new Error("No OpenOrc window is open. Open OpenOrc and retry.");
      pane = create(paneKey(window, surface), surface, window);
      // A background conversation can inspect its page without stealing the user's current panel.
      pane.view.setBounds({ x: 0, y: 0, width: 1000, height: 720 });
    }
    agentPanes.set(surface, pane);
  }
  if (pane.agentBusy) throw new Error("Another browser action is running in this conversation.");
  const target = pane;
  const contents = target.view.webContents;
  target.agentBusy = true;
  target.shown = ++reveals;
  target.revealRequested = true;
  if (contexts.get(target.window) === surface) target.window.webContents.send("browser:reveal", surface);
  try {
    return await runBrowserAction({
      contents,
      command,
      navigate: async (url) => {
        target.requested = url;
        target.error = null;
        target.pending = true;
        publish(target);
        await contents.loadURL(url);
      },
      readError: () => target.error,
      isAllowedUrl: isAllowedPaneUrl,
    });
  } finally {
    target.agentBusy = false;
  }
}

function revealedUrl(existing: boolean, requested: string, incoming: unknown): string | null {
  if (existing && requested !== "about:blank") return requested;
  return typeof incoming === "string" ? incoming : null;
}
