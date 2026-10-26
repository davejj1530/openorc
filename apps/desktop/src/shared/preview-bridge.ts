import type { PreviewHostCapture, PreviewHostInput, PreviewHostPage, PreviewInputRequest } from "@openorc/protocol";

/**
 * Utility to main: the core asks about a thread's Preview, or brings a phone's input for its shown pane. Never a
 * renderer, and never the agent's BrowserCommand.
 */
export type PreviewBridgeRequest =
  | { type: "preview.query"; id: number; threadId: string }
  | { type: "preview.capture"; id: number; threadId: string; width: number; quality: number; unless: string | null }
  | ({ type: "preview.input"; id: number; threadId: string } & PreviewInputRequest);

/** Utility to main, unanswered: a thread was deleted, so main closes its pages. */
export interface PreviewBridgeGone {
  type: "preview.gone";
  threadId: string;
}

/** Main to utility: an answer by request id, or a nudge that a thread's Preview changed. */
export type PreviewBridgeMessage =
  { type: "preview.result"; id: number; result: PreviewHostPage | PreviewHostCapture | PreviewHostInput | null; error?: string } | { type: "preview.changed"; threadId: string; lifecycle: boolean };
