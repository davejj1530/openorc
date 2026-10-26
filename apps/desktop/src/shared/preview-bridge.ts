import type { PreviewHostCapture, PreviewHostPage } from "@openorc/protocol";

/** Utility to main: the core asks about a thread's Preview. Never a renderer, and never an action on the page. */
export type PreviewBridgeRequest =
  { type: "preview.query"; id: number; threadId: string } | { type: "preview.capture"; id: number; threadId: string; width: number; quality: number; unless: string | null };

/** Utility to main, unanswered: a thread was deleted, so main closes its pages. */
export interface PreviewBridgeGone {
  type: "preview.gone";
  threadId: string;
}

/** Main to utility: an answer by request id, or a nudge that a thread's Preview changed. */
export type PreviewBridgeMessage =
  { type: "preview.result"; id: number; result: PreviewHostPage | PreviewHostCapture | null; error?: string } | { type: "preview.changed"; threadId: string; lifecycle: boolean };
