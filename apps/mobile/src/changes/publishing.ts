import { useSyncExternalStore } from "react";
import { link, shownMacId, storage } from "../client";
import { showsDemo } from "../connection/manager";
import { DROPPED } from "../connection/link-connection";
import { haptic } from "../ui/haptics";
import { createChangeDrafts } from "./drafts";
import type { Publishing } from "./publish-state";
import { createPublishStore } from "./publish-store";

/** The app's one publish store and its drafts, over the phone's storage and the shown Mac. */
export const publishStore = createPublishStore({ storage, macId: shownMacId, dropped: (error) => error.message === DROPPED, haptic, now: Date.now });
export const changeDrafts = createChangeDrafts(storage, shownMacId);

// Every demo has the same threads, so one demo's commit or push must not meet the next one's untouched workspace.
let demoShown = showsDemo(link.getState());
link.subscribe(() => {
  const shown = showsDemo(link.getState());
  if (demoShown && !shown) publishStore.reset();
  demoShown = shown;
});

export function usePublishing(threadId: string): Publishing {
  return useSyncExternalStore(publishStore.subscribe, () => publishStore.get(threadId));
}
