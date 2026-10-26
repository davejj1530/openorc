import { previewThreadId, type PreviewHost } from "@openorc/protocol";
import type { PreviewBridgeMessage, PreviewBridgeRequest } from "../shared/preview-bridge";

const FIELDS: Record<PreviewBridgeRequest["type"], string[]> = {
  "preview.query": ["id", "threadId", "type"],
  "preview.capture": ["id", "quality", "threadId", "type", "unless", "width"],
};
const between = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** Exactly a query or a capture with its fields in range: a request that also carries a command or a surface is neither. */
function parse(message: Record<string, unknown>): PreviewBridgeRequest | null {
  const type = message["type"] as PreviewBridgeRequest["type"];
  if (Object.keys(message).sort().join() !== FIELDS[type].join()) return null;
  if (!Number.isSafeInteger(message["id"]) || !previewThreadId.safeParse(message["threadId"]).success) return null;
  if (type === "preview.query") return message as PreviewBridgeRequest;
  const unless = message["unless"];
  const valid = between(message["width"], 320, 1600) && between(message["quality"], 10, 95) && (unless === null || (typeof unless === "string" && unless.length <= 64));
  return valid ? (message as PreviewBridgeRequest) : null;
}

/** A deleted thread's pages close, named by the thread alone; anything more is not this message. */
function gone(message: Record<string, unknown>, host: PreviewHost): void {
  if (Object.keys(message).sort().join() !== "threadId,type" || !previewThreadId.safeParse(message["threadId"]).success) return;
  host.threadGone(message["threadId"] as string);
}

/**
 * The phone's read of the Mac's Preview, on the core's private channel beside browser.command and apart from it: a
 * query and a capture, answered by request id, and a nudge when a thread's page changes; and, unanswered, a deleted
 * thread whose pages close. No renderer reaches it.
 */
export function installPreviewBridge(child: { on(event: "message" | "exit", listener: (message: unknown) => void): unknown; postMessage(message: unknown): void }, host: PreviewHost): void {
  const post = (message: PreviewBridgeMessage) => {
    try {
      child.postMessage(message);
    } catch {
      /* Core exited. */
    }
  };
  // A core that exits stops listening: the next one installs its own bridge.
  child.on(
    "exit",
    host.onChange((threadId, lifecycle) => post({ type: "preview.changed", threadId, lifecycle })),
  );
  child.on("message", (message: unknown) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (type === "preview.gone") return gone(message as Record<string, unknown>, host);
    if (type !== "preview.query" && type !== "preview.capture") return;
    const request = parse(message as Record<string, unknown>);
    if (!request) {
      const asked = (message as { id?: unknown }).id;
      if (Number.isSafeInteger(asked)) post({ type: "preview.result", id: asked as number, result: null, error: "Invalid Preview request." });
      return;
    }
    const work = request.type === "preview.query" ? host.query(request.threadId) : host.capture(request.threadId, { width: request.width, quality: request.quality, unless: request.unless });
    void work.then(
      (result) => post({ type: "preview.result", id: request.id, result }),
      (error: unknown) => post({ type: "preview.result", id: request.id, result: null, error: error instanceof Error ? error.message : String(error) }),
    );
  });
}
