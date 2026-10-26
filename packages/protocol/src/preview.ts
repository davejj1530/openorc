import { z } from "zod";

/** A thread id as the Mac's Preview bridge accepts a surface: letters, digits, `_` and `-`. */
export const previewThreadId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** How a phone reaches the Mac decides how fast frames come: the same network, or a tailnet that may be relayed. */
export const PreviewPace = z.enum(["lan", "tailnet"]);
export type PreviewPace = z.infer<typeof PreviewPace>;

export type PreviewPhase = "loading" | "live" | "failed" | "stopped";

/** The newest frame the Mac holds for a watched thread, fetched as an asset by its `seq`. */
export interface PreviewFrame {
  seq: number;
  width: number;
  height: number;
}

/** A thread's Preview as a phone hears it. `pane` is opaque and changes when the shown tab does. */
export type PreviewState = { open: false } | { open: true; pane: string; address: string; title: string; phase: PreviewPhase; error: string | null; frame: PreviewFrame | null };

/** No frame is larger: one over it is encoded again at a lower quality, then at three quarters of the width. */
export const PREVIEW_FRAME_BYTES = 256 * 1024;

/** The page the Mac's Preview shows for a thread, as main reads it. */
export interface PreviewHostPage {
  pane: string;
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  crashed: boolean;
}

/** One capture: unchanged since the digest the caller already holds, or a new JPEG of the viewport. */
export type PreviewHostCapture = { kind: "same" } | { kind: "frame"; pane: string; jpeg: Uint8Array; width: number; height: number; digest: string };

export interface PreviewCaptureOptions {
  width: number;
  quality: number;
  /** The digest of the frame the caller holds; an identical capture answers `same`. */
  unless: string | null;
}

/**
 * Main's side of the Preview, reached only by the core over the utility channel. Null is no page open for the thread.
 * Nothing here can click, type or navigate, and only a deleted thread's pages close: the agent's BrowserCommand stays
 * the only way to act on a page.
 */
export interface PreviewHost {
  query(threadId: string): Promise<PreviewHostPage | null>;
  capture(threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null>;
  /** `lifecycle` is true when whether a page is open, or which tab is shown, may have changed. */
  onChange(listener: (threadId: string, lifecycle: boolean) => void): () => void;
  /** The thread was deleted: main lets go of its pages. The core says so only once the thread is gone. */
  threadGone(threadId: string): void;
}

export const previewRpcParams = {
  /** Whether the Mac shows a page for this thread, and which; never a frame. */
  "preview.state": z.object({ threadId: previewThreadId }).strict(),
};

export interface PreviewRpcResults {
  "preview.state": PreviewState;
}

/**
 * Methods about the calling session itself. RemoteSession answers them for its own session; no core handler sees them,
 * and they are not RpcMethods, so no window can call them and no phone can name another session. One watch per session.
 */
export const sessionRpcParams = {
  "preview.watch": z.object({ threadId: previewThreadId, width: z.number().int().min(320).max(1600), pace: PreviewPace }).strict(),
  "preview.unwatch": z.object({}).strict(),
};
export type SessionMethod = keyof typeof sessionRpcParams;
export type SessionParams<M extends SessionMethod> = z.infer<(typeof sessionRpcParams)[M]>;
export interface SessionRpcResults {
  "preview.watch": PreviewState;
  "preview.unwatch": null;
}
export const isSessionMethod = (method: string): method is SessionMethod => Object.hasOwn(sessionRpcParams, method);
