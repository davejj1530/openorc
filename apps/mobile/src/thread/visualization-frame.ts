import { VisualizationFrameMessage } from "@openorc/protocol";
import type { z } from "zod";

type AnyFrameMessage = z.infer<typeof VisualizationFrameMessage>;

/** What a visualization's page may tell the phone: it is up, how tall it is, or that it failed. */
export type FrameMessage = Exclude<AnyFrameMessage, { method: "ui/notifications/sandbox-proxy-ready" }>;

/**
 * Reads one message from the page. The page's own script can post anything through the bridge, so only the
 * document's three notices pass; anything else, the desktop proxy's notice included, reads as nothing.
 */
export function readFrameMessage(data: string): FrameMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const result = VisualizationFrameMessage.safeParse(value);
  if (!result.success || result.data.method === "ui/notifications/sandbox-proxy-ready") return null;
  return result.data;
}

/** Where the frame stands: loading until the page says it is up, then ready, or failed with what the page said. */
export type FrameState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

/** A frame takes this much room until its page says how tall it is, as on the desktop. */
export const FIRST_HEIGHT = 320;

/**
 * What a frame last showed, kept while its row has no web view so the row takes the same space: its page at the
 * height it had, or the quiet line of a page that failed.
 */
export type FrameMemory = { kind: "page"; height: number } | { kind: "failed"; message: string };

/**
 * The frame's state after a message, as the desktop moves it: up means ready, even after a slow start timed out, and
 * a page that failed while loading says so again once it is up. A size changes only the height.
 */
export function frameStep(state: FrameState, message: FrameMessage): FrameState {
  switch (message.method) {
    case "ui/notifications/initialized":
      return { kind: "ready" };
    case "openorc/visualization-error":
      return { kind: "error", message: message.params.message };
    case "ui/notifications/size-changed":
      return state;
  }
}

/** The page the web view loads has no address of its own: about:blank, so its origin is opaque. */
export const FRAME_BASE = "about:blank";

/** A load the web view asks about: where to, and whether it is the page itself or a frame in it. */
export interface LoadRequest {
  url: string;
  isTopFrame: boolean;
}

/**
 * The web view's only load is its own page. Every load after it is refused: a link, a script moving the page, a
 * reload, a frame the page adds. One guard per web view, made when it mounts.
 */
export function loadGuard(): (request: LoadRequest) => boolean {
  let loaded = false;
  return ({ url, isTopFrame }) => {
    if (loaded || !isTopFrame || url !== FRAME_BASE) return false;
    loaded = true;
    return true;
  };
}
