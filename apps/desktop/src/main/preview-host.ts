import { createHash } from "node:crypto";
import { BrowserWindow, nativeImage, type NativeImage, type WebContents } from "electron";
import { PREVIEW_FRAME_BYTES, type PreviewCaptureOptions, type PreviewHost, type PreviewHostCapture, type PreviewHostPage } from "@openorc/protocol";
import { closeThreadPanes, keepPainting, onPaneChange, threadPanes, type Pane } from "./browser-pane";

/** A screenshot that has not come by then is a view that is not compositing; its last painted frame stands in. */
const ANSWER_MS = 2_000;
/** The screenshot's own quality, before it is resized and encoded at the phone's. */
const SOURCE_QUALITY = 90;
const THREAD_SURFACE = /^thread:([A-Za-z0-9_-]+)(?::tab:.*)?$/;

interface Encoded {
  jpeg: Uint8Array;
  width: number;
  height: number;
}
/** The visual viewport in CSS pixels and its scroll offset. */
interface Viewport {
  clientWidth: number;
  clientHeight: number;
  pageX: number;
  pageY: number;
}

const sha = (algorithm: string, text: string | Uint8Array) => createHash(algorithm).update(text).digest("hex");

/** Opaque to the phone and stable for the pane: the desktop's tab ids never cross. */
const paneId = (pane: Pane) => sha("sha256", `${pane.window.id}\n${pane.surface}`).slice(0, 12);

const urlOf = (pane: Pane) => pane.view.webContents.getURL() || pane.requested;
const loading = (pane: Pane) => pane.view.webContents.isLoading() || pane.pending;
/** A pane at about:blank that is not loading has nothing to show. */
const open = (pane: Pane) => !(urlOf(pane) === "about:blank" && !loading(pane));

/**
 * The page a thread's Preview is: the tab its agent's browser tool acts on, which is also the tab last shown on the
 * Mac; without one, the attached pane in the focused window, else any attached pane, else the one shown last.
 */
export function currentPane(threadId: string): Pane | null {
  const { agent, tabs } = threadPanes(threadId);
  if (agent && open(agent)) return agent;
  const live = tabs.filter(open);
  const focused = BrowserWindow.getFocusedWindow();
  const latest = live.reduce<Pane | null>((best, pane) => (best === null || pane.shown > best.shown ? pane : best), null);
  return live.find((pane) => pane.attached && pane.window === focused) ?? live.find((pane) => pane.attached) ?? latest;
}

function readPage(pane: Pane): PreviewHostPage {
  return { pane: paneId(pane), url: urlOf(pane), title: pane.view.webContents.getTitle(), loading: loading(pane), error: pane.error, crashed: pane.crashed };
}

/** Calls into a pane that have not answered yet, by kind. None is sent again until the last one answers. */
const waiting = new WeakMap<WebContents, Set<"screenshot" | "paint">>();

/** Null when a call of this kind is still out for the pane, or when this one does not answer in time. */
async function inTime<T>(contents: WebContents, kind: "screenshot" | "paint", start: () => Promise<T>): Promise<T | null> {
  const out = waiting.get(contents) ?? new Set();
  waiting.set(contents, out);
  if (out.has(kind)) return null;
  out.add(kind);
  const asked = start().finally(() => out.delete(kind));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ANSWER_MS)));
  return Promise.race([asked, late]).finally(() => clearTimeout(timer));
}

async function viewport(contents: WebContents): Promise<Viewport | null> {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const metrics = (await contents.debugger.sendCommand("Page.getLayoutMetrics")) as { cssVisualViewport: Viewport };
  const viewport = metrics.cssVisualViewport;
  return viewport.clientWidth > 0 && viewport.clientHeight > 0 ? viewport : null;
}

/**
 * The viewport at the pane's own pixels, through the pane's debugger (the browser tool's own path for screenshots).
 * Unlike capturePage it paints a fresh frame for a view in a window covered by others or off its window, and the
 * page's visibilityState stays hidden. Never scaled there: a scaled clip renders the page smaller for a frame, which
 * shows on the Mac's screen, and stays on a view off screen until it paints again.
 */
async function screenshot(contents: WebContents, view: Viewport): Promise<NativeImage | null> {
  const clip = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: 1 };
  const shot = (await inTime(contents, "screenshot", () => contents.debugger.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: SOURCE_QUALITY, clip, optimizeForSpeed: true }))) as {
    data: string;
  } | null;
  return shot ? nativeImage.createFromBuffer(Buffer.from(shot.data, "base64")) : null;
}

/** The last frame the pane painted: what a view whose screenshot did not come still has. */
function lastPainted(contents: WebContents): Promise<NativeImage | null> {
  return inTime(contents, "paint", () => contents.capturePage(undefined, { stayHidden: true }));
}

/** Never wider than the pane's own pixels. */
function encode(image: NativeImage, width: number, quality: number): Encoded {
  const resized = image.getSize().width > width ? image.resize({ width, quality: "good" }) : image;
  return { jpeg: resized.toJPEG(quality), ...resized.getSize() };
}

/** At most 256 KB: the asked quality, then 15 lower, then three quarters of the width at that quality. */
function underCap(image: NativeImage, width: number, quality: number): Encoded {
  let encoded = encode(image, width, quality);
  if (encoded.jpeg.length > PREVIEW_FRAME_BYTES) encoded = encode(image, width, quality - 15);
  if (encoded.jpeg.length > PREVIEW_FRAME_BYTES) encoded = encode(image, Math.round(width * 0.75), quality - 15);
  return encoded;
}

/** A view laid out at zero size mid-layout has nothing to give. */
async function frameOf(pane: Pane, { width, quality }: PreviewCaptureOptions): Promise<Encoded | null> {
  const contents = pane.view.webContents;
  // A view on a minimized or hidden window paints nothing new; off the window it does, until the window shows.
  if (pane.attached && (pane.window.isMinimized() || !pane.window.isVisible())) keepPainting(pane);
  const view = await viewport(contents);
  if (!view) return null;
  const image = (await screenshot(contents, view)) ?? (await lastPainted(contents));
  return image && !image.isEmpty() ? underCap(image, width, quality) : null;
}

async function capture(threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null> {
  const pane = currentPane(threadId);
  if (!pane || pane.crashed) return null;
  const started = performance.now();
  const encoded = await frameOf(pane, options).catch(() => null);
  if (!encoded) return null;
  const digest = sha("sha1", encoded.jpeg);
  const result: PreviewHostCapture = digest === options.unless ? { kind: "same" } : { kind: "frame", pane: paneId(pane), digest, ...encoded };
  if (__OPENORC_QA__)
    console.log(`[preview] capture ${threadId.slice(0, 8)} ${result.kind} ${encoded.width}x${encoded.height} ${encoded.jpeg.length} B ${(performance.now() - started).toFixed(1)} ms`);
  return result;
}

/**
 * Main's side of the Mac's Preview for phones: which page a thread shows, a frame of it, and a nudge when it changes.
 * `lifecycle` marks a change in whether a page is open or which tab it is, so More's item updates only then.
 */
export function createPreviewHost(): PreviewHost {
  const listeners = new Set<(threadId: string, lifecycle: boolean) => void>();
  const shown = new Map<string, string>();
  let unsubscribe: (() => void) | null = null;
  const heard = (surface: string) => {
    const threadId = THREAD_SURFACE.exec(surface)?.[1];
    if (!threadId) return;
    const pane = currentPane(threadId);
    const now = pane ? paneId(pane) : null;
    const lifecycle = (shown.get(threadId) ?? null) !== now;
    if (now) shown.set(threadId, now);
    else shown.delete(threadId);
    for (const listener of listeners) listener(threadId, lifecycle);
  };
  return {
    query: (threadId) => {
      const pane = currentPane(threadId);
      return Promise.resolve(pane ? readPage(pane) : null);
    },
    capture,
    threadGone: closeThreadPanes,
    onChange: (listener) => {
      listeners.add(listener);
      unsubscribe ??= onPaneChange(heard);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribe?.();
        unsubscribe = null;
      };
    },
  };
}
