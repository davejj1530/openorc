import { conversationSendDisabledReason } from "@openorc/client";
import { movingHold, type ThreadSummary } from "@openorc/protocol";
import { threadLinkReason } from "../connection/link-reason";
import type { LinkState } from "../connection/manager";

/**
 * Why the composer cannot send now: a move under way between the Mac and OpenOrc Cloud first, as the desktop holds it,
 * then the link to the Mac for a thread that needs it, then the conversation's own state.
 */
export function sendBlocked(
  link: LinkState,
  settings: { permissionReady: boolean; choice: unknown },
  runs: { isLoading: boolean; error: unknown },
  thread: ThreadSummary | null,
  ownCloud: boolean,
): string | null {
  return (
    movingHold(thread?.moving, link.kind === "unpaired" ? "" : link.mac.name) ??
    threadLinkReason(link, thread, ownCloud) ??
    conversationSendDisabledReason({
      permissionReady: settings.permissionReady,
      historyLoading: runs.isLoading,
      historyFailed: Boolean(runs.error),
      hasModel: Boolean(settings.choice),
      thread,
    })
  );
}
