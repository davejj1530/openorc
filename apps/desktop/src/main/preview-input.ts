import type { WebContents } from "electron";
import type { PreviewFocus, PreviewHostInput, PreviewInput, PreviewInputRequest } from "@openorc/protocol";
import { deepHit, pageCall, pageDialogs, pageFocus, pageHit, pageScroll } from "./preview-page";

/** What applying a phone's input needs of a pane: its debugger, and an isolated world of its own for page code. */
export interface PaneLink {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Page code in the phone's isolated world; its value comes back. */
  run(code: string): Promise<unknown>;
}

/** The visual viewport in CSS pixels, as Page.getLayoutMetrics reads it. */
interface Viewport {
  clientWidth: number;
  clientHeight: number;
  offsetX?: number;
  offsetY?: number;
}

/** A phone drives a pane from its input until this long after its last. */
const DRIVES_MS = 3_000;
/** A frame whose shape differs from the viewport's by more than this is of another layout. */
const ASPECT_SLACK = 0.03;
/** Apart from the agent's world (1001), so neither sees the other's references. */
const PHONE_WORLD = 1002;

interface Drive {
  /** The dialog shim's registration for new documents, which carries the drive's end. */
  script: string | null;
  intercepting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
const drives = new WeakMap<PaneLink, Drive>();

/**
 * Marks the pane as driven for 3 s more. The dialog shim goes into every document the pane has and every one it loads
 * after, as a link the tap followed loads a page with none of this one's state, with the drive's end in its source; it
 * replaces the last input's. File choosers are intercepted (and cancelled) so no open panel shows, until 3 s after the
 * last input. The state is the pane's; this input's steps go through `link`.
 */
async function drive(pane: PaneLink, link: PaneLink): Promise<void> {
  let state = drives.get(pane);
  if (!state) {
    state = { script: null, intercepting: false, timer: null };
    drives.set(pane, state);
    await link.send("Page.enable");
  }
  const source = pageCall(pageDialogs, Date.now() + DRIVES_MS);
  const { identifier } = (await link.send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true })) as { identifier: string };
  if (state.script) await link.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.script });
  state.script = identifier;
  if (!state.intercepting) {
    state.intercepting = true;
    await link.send("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true });
  }
  if (state.timer) clearTimeout(state.timer);
  const current = state;
  current.timer = setTimeout(() => {
    current.timer = null;
    current.intercepting = false;
    void pane.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }, DRIVES_MS);
}

const round = (value: number) => Math.round(value * 100) / 100;

/** From the frame's pixels onto the viewport's CSS pixels: a point, and a distance (which takes no offset). */
interface Mapping {
  point(x: number, y: number): { x: number; y: number };
  distance(x: number, y: number): { x: number; y: number };
}

/** Null when the frame is of another shape than the viewport, as after a resize. */
function onViewport(view: Viewport, frame: PreviewInputRequest["frame"]): Mapping | null {
  const frameAspect = frame.width / frame.height;
  const viewAspect = view.clientWidth / view.clientHeight;
  if (!(Math.abs(frameAspect / viewAspect - 1) <= ASPECT_SLACK)) return null;
  // Each axis by its own scale: the frame's height was rounded to whole pixels.
  const across = view.clientWidth / frame.width;
  const down = view.clientHeight / frame.height;
  return {
    point: (x, y) => ({ x: round(x * across + (view.offsetX ?? 0)), y: round(y * down + (view.offsetY ?? 0)) }),
    distance: (x, y) => ({ x: round(x * across), y: round(y * down) }),
  };
}

/** Key events as Chromium wants them: a key with text is keyDown, one without rawKeyDown. */
const KEYS = {
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
} as const;

async function press(link: PaneLink, key: keyof typeof KEYS, count: number): Promise<void> {
  const event = KEYS[key];
  for (let i = 0; i < count; i++) {
    await link.send("Input.dispatchKeyEvent", { type: "text" in event ? "keyDown" : "rawKeyDown", ...event });
    const { text: _text, ...up } = event as { text?: string };
    await link.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
  }
}

/** A press and a release at the point. No move first: a pane off screen takes a move only with its next frame. */
async function click(link: PaneLink, at: { x: number; y: number }, count: number): Promise<void> {
  await link.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: count });
  await link.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: count });
}

/** One input onto the page, its points mapped onto the viewport. */
async function deliver(link: PaneLink, input: PreviewInput, map: Mapping): Promise<void> {
  switch (input.kind) {
    case "tap": {
      const at = map.point(input.x, input.y);
      if ((await link.run(pageCall(pageHit, at, deepHit))) === "click") await click(link, at, input.count);
      return;
    }
    case "scroll": {
      const by = map.distance(input.dx, input.dy);
      await link.run(pageCall(pageScroll, { ...map.point(input.x, input.y), dx: by.x, dy: by.y }, deepHit));
      return;
    }
    case "text":
      await link.send("Input.insertText", { text: input.text });
      return;
    case "key":
      return press(link, input.key, input.count);
    case "choose":
      return;
  }
}

/** A release finishes what its press began, so it goes even once the input came too late. */
const finishes = (params?: Record<string, unknown>) => params?.["type"] === "mouseReleased" || params?.["type"] === "keyUp";

/** The link until `late` aborts; after, nothing more reaches the page but the release of a press already sent. */
function inTime(link: PaneLink, late: AbortSignal): PaneLink {
  return {
    send: (method, params) => (late.aborted && !finishes(params) ? Promise.reject(late.reason as Error) : link.send(method, params)),
    run: (code) => (late.aborted ? Promise.reject(late.reason as Error) : link.run(code)),
  };
}

const NEVER_LATE = new AbortController().signal;

/**
 * Applies a phone's input to a pane with its debugger's Input domain, which reaches a hidden or never-attached pane
 * without the window's OS focus, then reads the page's focus. Never the agent's BrowserCommand. Once `late` aborts (the
 * phone was told the page did not take it in time), the steps not sent yet are dropped and the promise rejects.
 */
export async function applyInput(pane: PaneLink, { frame, input }: PreviewInputRequest, late = NEVER_LATE): Promise<PreviewHostInput> {
  const link = inTime(pane, late);
  const metrics = (await link.send("Page.getLayoutMetrics")) as { cssVisualViewport: Viewport };
  const map = onViewport(metrics.cssVisualViewport, frame);
  if (!map) return { kind: "refused", reason: "pane" };
  await drive(pane, link);
  await deliver(link, input, map);
  const focus = (await link.run(pageCall(pageFocus, input.kind === "choose" ? input.index : null))) as PreviewFocus | null;
  return { kind: "applied", focus };
}

const links = new WeakMap<WebContents, PaneLink>();

/** A pane's link, one per page contents, so its drive state lasts as long as the page. */
export function paneLink(contents: WebContents): PaneLink {
  let link = links.get(contents);
  if (link) return link;
  const created: PaneLink = {
    send: (method, params) => {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
      return contents.debugger.sendCommand(method, params);
    },
    run: (code) => contents.executeJavaScriptInIsolatedWorld(PHONE_WORLD, [{ code }], true),
  };
  // A debugger that detaches forgets the shim and the interception: the next input sets them up again.
  contents.debugger.on("detach", () => drives.delete(created));
  links.set(contents, created);
  link = created;
  return link;
}
