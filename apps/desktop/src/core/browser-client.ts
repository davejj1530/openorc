import type { BrowserCommand, BrowserHost, BrowserResult } from "@openorc/protocol";

/** Private utility/main channel. Browser payloads never go through the renderer RPC bus. */
export class BrowserClient {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(result: BrowserResult): void; reject(error: Error): void }>();
  constructor(private readonly send: (message: unknown) => void) {}

  readonly execute: BrowserHost = (surface: string, command: BrowserCommand) => {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
      };
      const timeout = setTimeout(() => {
        finish();
        reject(new Error("The sidebar browser did not respond. Retry after checking the preview."));
      }, 35000);
      this.pending.set(id, {
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        this.send({ type: "browser.command", id, surface, command });
      } catch {
        this.pending.get(id)?.reject(new Error("The sidebar browser is unavailable."));
      }
    });
  };

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const reply = message as { type?: unknown; id?: number; result?: BrowserResult; error?: string };
    if (reply.type !== "browser.result") return false;
    const pending = reply.id === undefined ? undefined : this.pending.get(reply.id);
    if (pending) {
      if (reply.error || !reply.result) pending.reject(new Error(reply.error ?? "The sidebar browser returned no result."));
      else pending.resolve(reply.result);
    }
    return true;
  }
}
