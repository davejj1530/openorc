import type { ThreadSummary } from "@openorc/protocol";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useRpcMutation, useSession } from "../client";

/**
 * Looking at the thread reads it. A reply that lands while the app is in the background stays unread until it returns;
 * while the Mac still says unread, each new session marks again, so a mark a dropped session lost is not lost.
 */
export function useMarkSeen(thread: ThreadSummary | null) {
  const { mutate } = useRpcMutation("threads.update");
  const session = useSession();
  useEffect(() => {
    if (!thread?.unread || session === null) return;
    const mark = () => {
      if (AppState.currentState === "active") mutate({ id: thread.id, patch: { seen: true } });
    };
    mark();
    const subscription = AppState.addEventListener("change", (state) => state === "active" && mark());
    return () => subscription.remove();
    // A new unread reply marks again; the mutation's own status changes do not.
  }, [thread?.id, thread?.unread, thread?.lastActivityAt, session, mutate]);
}
