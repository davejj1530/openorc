import { randomUUID } from "node:crypto";
import type { CoreProcess } from "./host-core";

/** Why the core closes: to install an update, or for main to start it somewhere else, such as inside a WSL distribution. */
export type ClosePurpose = "update" | "switch";

/** Why the core would not close, in its words for what was asked. `retry` marks a refusal that passes by itself: a request caught mid-flight. */
export interface CloseRefusal {
  reason: string;
  retry: boolean;
}

/** A reply alone is not enough: the database and writers must close and the core's process must exit cleanly. */
export function closeCore(child: Pick<CoreProcess, "postMessage" | "on" | "removeListener">, purpose: ClosePurpose, timeoutMs = 30_000): Promise<CloseRefusal | null> {
  const undone = purpose === "update" ? "The update was not installed." : "OpenOrc is still running where it was.";
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let prepared = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", message);
      child.removeListener("exit", exited);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const message = (value: unknown) => {
      if (!value || typeof value !== "object" || !("type" in value) || !("id" in value) || value.id !== id) return;
      if (value.type === "update:blocked" && "reason" in value && typeof value.reason === "string") {
        cleanup();
        resolve({ reason: value.reason, retry: "retry" in value && value.retry === true });
      } else if (value.type === "update:prepared") {
        prepared = true;
        // The core has said it is closing, and it will. A switch waits for that however long the ledger takes: giving
        // up here would report a place as still running that is on its way out.
        if (purpose === "switch") clearTimeout(timer);
      }
    };
    const exited = (code: number) => {
      cleanup();
      if (prepared && code === 0) resolve(null);
      else reject(new Error(`The core did not confirm a clean shutdown. ${undone}`));
    };
    // Never kill the core to meet an installation deadline. For a switch the deadline is for the core's answer alone.
    const timer = setTimeout(() => fail(new Error(`The core is still shutting down. ${undone}`)), timeoutMs);
    child.on("message", message);
    child.on("exit", exited);
    try {
      child.postMessage({ type: "update:prepare", id, ...(purpose === "switch" ? { purpose } : {}) });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Closes the core for a switch. A request caught mid-flight refuses the close for a moment, which an update leaves to
 * the person to try again; a switch waits it out, and gives up with the core's words only if requests never pause.
 */
export async function closeWhenIdle(close: () => Promise<CloseRefusal | null>, { attempts = 40, waitMs = 500 } = {}): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const refusal = await close();
    if (!refusal) return null;
    if (!refusal.retry || attempt >= attempts) return refusal.reason;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Closes the core to install an update, or gives the reason it would not close. */
export async function closeCoreForUpdate(child: Pick<CoreProcess, "postMessage" | "on" | "removeListener">, timeoutMs = 30_000): Promise<string | null> {
  return (await closeCore(child, "update", timeoutMs))?.reason ?? null;
}
