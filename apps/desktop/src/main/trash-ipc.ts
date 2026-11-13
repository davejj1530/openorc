import { isAbsolute } from "node:path";
import { shell } from "electron";

/**
 * Moves what the core asks to the system Trash. Only main can reach Electron's shell; the core asks over its private
 * utility channel, never a renderer. A failure is answered with its reason, and nothing is deleted instead.
 */
export function installTrash(
  child: { on(event: "message", listener: (message: unknown) => void): unknown; postMessage(message: unknown): void },
  trashItem: (file: string) => Promise<void> = (file) => shell.trashItem(file),
): void {
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; id?: unknown; file?: unknown };
    if (request.type !== "trash" || !Number.isSafeInteger(request.id)) return;
    const respond = (error?: string) => {
      try {
        child.postMessage({ type: "trash.result", id: request.id, ...(error === undefined ? {} : { error }) });
      } catch {
        /* Core exited. */
      }
    };
    if (typeof request.file !== "string" || !isAbsolute(request.file)) {
      respond("Only a full path can be moved to the Trash.");
      return;
    }
    trashItem(request.file).then(
      () => respond(),
      (error: unknown) => respond(error instanceof Error ? error.message : String(error)),
    );
  });
}
