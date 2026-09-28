import { BrowserCommand, type BrowserHost } from "@openorc/protocol";

/** Only the core process owns this channel; renderers cannot submit browser commands. */
export function installBrowserBridge(child: { on(event: "message", listener: (message: unknown) => void): unknown; postMessage(message: unknown): void }, execute: BrowserHost): void {
  const queues = new Map<string, Promise<unknown>>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; id?: unknown; surface?: unknown; command?: unknown };
    if (request.type !== "browser.command" || !Number.isSafeInteger(request.id)) return;
    const respond = (payload: object) => {
      try {
        child.postMessage({ type: "browser.result", id: request.id, ...payload });
      } catch {
        /* Core exited. */
      }
    };
    const command = BrowserCommand.safeParse(request.command);
    if (typeof request.surface !== "string" || !/^(thread|task):[A-Za-z0-9_-]+$/.test(request.surface) || !command.success) {
      respond({ error: "Invalid sidebar browser command." });
      return;
    }
    const surface = request.surface;
    // Reject overlap rather than leaving a click queued against a page another tool changed.
    if (queues.has(surface)) {
      respond({ error: "Another browser action is running in this conversation. Wait for its result and retry." });
      return;
    }
    const work = Promise.resolve().then(() => execute(surface, command.data));
    queues.set(surface, work);
    void work
      .then(
        (result) => respond({ result }),
        (error: unknown) => respond({ error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => queues.delete(surface));
  });
}
