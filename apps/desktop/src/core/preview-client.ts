import type { PreviewCaptureOptions, PreviewHost, PreviewHostCapture, PreviewHostPage } from "@openorc/protocol";
import type { PreviewBridgeGone, PreviewBridgeMessage, PreviewBridgeRequest } from "../shared/preview-bridge";

const TIMEOUT_MS = 5_000;
type Result = PreviewHostPage | PreviewHostCapture | null;

/** The core's side of main's Preview, over the private utility channel the browser tool uses. Read-only by type. */
export class PreviewClient {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(result: Result): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(threadId: string, lifecycle: boolean) => void>();
  constructor(private readonly send: (message: PreviewBridgeRequest | PreviewBridgeGone) => void) {}

  readonly host: PreviewHost = {
    query: (threadId) => this.request({ type: "preview.query", id: ++this.nextId, threadId }) as Promise<PreviewHostPage | null>,
    capture: (threadId, { width, quality, unless }: PreviewCaptureOptions) =>
      this.request({ type: "preview.capture", id: ++this.nextId, threadId, width, quality, unless }) as Promise<PreviewHostCapture | null>,
    onChange: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    threadGone: (threadId) => {
      try {
        this.send({ type: "preview.gone", threadId });
      } catch {
        // Main has gone too, and its panes with it.
      }
    },
  };

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const reply = message as PreviewBridgeMessage;
    if (reply.type === "preview.changed") {
      for (const listener of this.listeners) listener(reply.threadId, reply.lifecycle);
      return true;
    }
    if (reply.type !== "preview.result") return false;
    const pending = this.pending.get(reply.id);
    if (reply.error) pending?.reject(new Error(reply.error));
    else pending?.resolve(reply.result);
    return true;
  }

  private request(message: PreviewBridgeRequest): Promise<Result> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => settle.reject(new Error("The Mac's Preview did not answer.")), TIMEOUT_MS);
      const done = () => {
        clearTimeout(timeout);
        this.pending.delete(message.id);
      };
      const settle = {
        resolve: (result: Result) => (done(), resolve(result)),
        reject: (error: Error) => (done(), reject(error)),
      };
      this.pending.set(message.id, settle);
      try {
        this.send(message);
      } catch {
        settle.reject(new Error("The Mac's Preview is unavailable."));
      }
    });
  }
}
