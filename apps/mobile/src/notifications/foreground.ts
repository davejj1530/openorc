import { noticeVisible } from "@openorc/client";
import type { LinkState } from "../connection/manager";
import { routeOf } from "./taps";

export interface Presentation {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

const SHOWN: Presentation = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
const HIDDEN: Presentation = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

/**
 * An alert that arrives while the app is open: nothing when its thread is on screen, live from its Mac or from the
 * phone's own OpenOrc Cloud (`cloudSender`), as the desktop decides for a window. While not connected the screen may be
 * stale, so it shows. The sound is whatever the sender sent.
 */
export function presentationFor(data: unknown, link: LinkState, threadOnScreen: string | null, cloudSender: string | null = null): Presentation {
  const route = routeOf(data);
  if (!route?.threadId) return SHOWN;
  const focused = route.macId === cloudSender || (link.kind === "connected" && link.mac.id === route.macId);
  return noticeVisible({ threadId: route.threadId, taskId: null }, { focused, threadIds: threadOnScreen ? [threadOnScreen] : [], taskId: null }) ? HIDDEN : SHOWN;
}

/** One banner per notice: the same notice heard twice shows once. */
export function oncePerNotice(present: (data: unknown) => Presentation, remember = 200): (data: unknown) => Presentation {
  const seen: string[] = [];
  return (data) => {
    const id = routeOf(data)?.id;
    if (id && seen.includes(id)) return HIDDEN;
    if (id) seen.push(id);
    if (seen.length > remember) seen.shift();
    return present(data);
  };
}

export interface Delivered {
  delivered(): Promise<{ id: string; data: unknown }[]>;
  dismiss(id: string): Promise<void>;
}

/** Opening a thread on the phone reads what its alerts said, from any of `senders`, so they leave Notification Center. */
export async function clearDelivered(senders: readonly string[], threadId: string, center: Delivered): Promise<void> {
  for (const { id, data } of await center.delivered()) {
    const route = routeOf(data);
    if (route && senders.includes(route.macId) && route.threadId === threadId) await center.dismiss(id);
  }
}
