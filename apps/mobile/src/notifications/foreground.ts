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
 * An alert that arrives while the app is open: nothing when its thread is on screen, live from its Mac, as the desktop
 * decides for a window. While not connected the screen may be stale, so it shows. The sound is whatever the Mac sent.
 */
export function presentationFor(data: unknown, link: LinkState, threadOnScreen: string | null): Presentation {
  const route = routeOf(data);
  if (!route?.threadId) return SHOWN;
  const focused = link.kind === "connected" && link.mac.id === route.macId;
  return noticeVisible({ threadId: route.threadId, taskId: null }, { focused, threadIds: threadOnScreen ? [threadOnScreen] : [], taskId: null }) ? HIDDEN : SHOWN;
}

export interface Delivered {
  delivered(): Promise<{ id: string; data: unknown }[]>;
  dismiss(id: string): Promise<void>;
}

/** Opening a thread on the phone reads what its alerts said, so they leave Notification Center. */
export async function clearDelivered(macId: string, threadId: string, center: Delivered): Promise<void> {
  for (const { id, data } of await center.delivered()) {
    const route = routeOf(data);
    if (route?.macId === macId && route.threadId === threadId) await center.dismiss(id);
  }
}
