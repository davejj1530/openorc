import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import type { EventEmitter } from "node:events";

/** A reply alone is not enough: the database and writers must close and the utility process must exit cleanly. */
export function closeCoreForUpdate(child: Pick<UtilityProcess, "postMessage"> & Pick<EventEmitter, "on" | "removeListener">, timeoutMs = 30_000): Promise<string | null> {
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
        resolve(value.reason);
      } else if (value.type === "update:prepared") prepared = true;
    };
    const exited = (code: number) => {
      cleanup();
      if (prepared && code === 0) resolve(null);
      else reject(new Error("The core did not confirm a clean shutdown. The update was not installed."));
    };
    // Never kill the core to meet an installation deadline.
    const timer = setTimeout(() => fail(new Error("The core is still shutting down. The update was not installed.")), timeoutMs);
    child.on("message", message);
    child.on("exit", exited);
    try {
      child.postMessage({ type: "update:prepare", id });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
