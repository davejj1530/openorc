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

/** A tab's id as a phone hears it: the first 12 hex of a digest, so the desktop's own tab ids never cross. */
export const previewPane = z.string().regex(/^[0-9a-f]{12}$/);

/** A frame's size in its own pixels: the space a phone's points are in. */
const previewFrameSize = z.object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).strict();
const framePoint = { x: z.number().min(0).max(4096), y: z.number().min(0).max(4096) };
const scrollDelta = z.number().min(-20_000).max(20_000);

/** The most text one input carries; a longer paste goes as several. */
export const PREVIEW_TEXT_CHARS = 1000;

/**
 * What a person does on the phone to the page it shows: a click, a scroll by the finger's travel (both at a point in
 * the shown frame's pixels), text or a key into the focused field, an option of the focused select.
 */
export const PreviewInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), ...framePoint, count: z.number().int().min(1).max(3) }).strict(),
  z.object({ kind: z.literal("scroll"), ...framePoint, dx: scrollDelta, dy: scrollDelta }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(PREVIEW_TEXT_CHARS) }).strict(),
  z.object({ kind: z.literal("key"), key: z.enum(["Backspace", "Enter", "Tab"]), count: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("choose"), index: z.number().int().min(0).max(499) }).strict(),
]);
export type PreviewInput = z.infer<typeof PreviewInput>;

/** An input for the pane the phone's frame shows, with that frame's size; main drops it when that pane is not shown. */
export const PreviewInputRequest = z.object({ pane: previewPane, frame: previewFrameSize, input: PreviewInput }).strict();
export type PreviewInputRequest = z.infer<typeof PreviewInputRequest>;

export type PreviewKeyboard = "default" | "email" | "url" | "numeric" | "decimal" | "tel" | "search";
export type PreviewEnterKey = "default" | "go" | "next" | "search" | "send" | "done";
export interface PreviewChoice {
  label: string;
  disabled: boolean;
}

/** What the Mac's focus is after an input: a field to type into, a select to choose in, or neither (null). */
export type PreviewFocus = { kind: "text"; keyboard: PreviewKeyboard; enter: PreviewEnterKey; secure: boolean; multiline: boolean } | { kind: "choice"; options: PreviewChoice[]; selected: number };

/**
 * Main's answer to an input: applied, or refused because another pane is shown, the agent holds this one, or its page
 * has not taken an input in time.
 */
export type PreviewHostInput = { kind: "applied"; focus: PreviewFocus | null } | { kind: "refused"; reason: "pane" | "busy" | "stuck" };

/** Why an input did not reach the page, in the phone's words. */
export const PREVIEW_INPUT_WORDS = {
  unwatched: "This page is not being watched.",
  pane: "The page changed.",
  busy: "The agent is using this page.",
  stuck: "The page is not responding.",
  rate: "Too many inputs at once.",
  closed: "Preview is closed.",
} as const;

/** A session sends at most this many inputs in any second. */
export const PREVIEW_INPUT_RATE = { inputs: 30, perMs: 1000 } as const;

/**
 * Main's side of the Preview, reached only by the core over the utility channel. Null is no page open for the thread.
 * A phone's input reaches the page only through `input`, never the agent's BrowserCommand, and only a deleted thread's
 * pages close.
 */
export interface PreviewHost {
  query(threadId: string): Promise<PreviewHostPage | null>;
  capture(threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null>;
  /** A phone's input on the thread's shown pane, in turn with the agent's commands. */
  input(threadId: string, request: PreviewInputRequest): Promise<PreviewHostInput | null>;
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
 * and they are not RpcMethods, so no window can call them and no phone can name another session. One watch per session,
 * and input only for what it watches.
 */
export const sessionRpcParams = {
  "preview.watch": z.object({ threadId: previewThreadId, width: z.number().int().min(320).max(1600), pace: PreviewPace }).strict(),
  "preview.unwatch": z.object({}).strict(),
  /** Only for the thread this session watches, and the pane its frame shows. */
  "preview.input": z.object({ threadId: previewThreadId, pane: previewPane, frame: previewFrameSize, input: PreviewInput }).strict(),
};
export type SessionMethod = keyof typeof sessionRpcParams;
export type SessionParams<M extends SessionMethod> = z.infer<(typeof sessionRpcParams)[M]>;
export interface SessionRpcResults {
  "preview.watch": PreviewState;
  "preview.unwatch": null;
  "preview.input": { focus: PreviewFocus | null };
}
export const isSessionMethod = (method: string): method is SessionMethod => Object.hasOwn(sessionRpcParams, method);
