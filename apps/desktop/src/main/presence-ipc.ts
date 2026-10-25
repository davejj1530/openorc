import { powerMonitor } from "electron";

/** Input this recently means someone is at the Mac, so phone alerts hold back. */
const ACTIVE_WITHIN_S = 120;

/**
 * Answers the core's private "is the Mac in use" question. powerMonitor exists only in main; the core asks once per
 * phone alert and reads no answer as away.
 */
export function installPresence(
  child: { on(event: "message", listener: (message: unknown) => void): unknown; postMessage(message: unknown): void },
  idleState: () => string = () => powerMonitor.getSystemIdleState(ACTIVE_WITHIN_S),
): void {
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; id?: unknown };
    if (request.type !== "presence" || !Number.isSafeInteger(request.id)) return;
    let inUse = false;
    try {
      inUse = idleState() === "active";
    } catch {
      // Unknown reads as away.
    }
    try {
      child.postMessage({ type: "presence.result", id: request.id, inUse });
    } catch {
      /* Core exited. */
    }
  });
}
