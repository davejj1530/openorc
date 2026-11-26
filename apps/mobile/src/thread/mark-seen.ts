import type { ThreadSummary } from "@openorc/protocol";
import { useEffect } from "react";
import { AppState } from "react-native";
import { useRpcMutation, useSession } from "../client";
import { useOwnCloud } from "../cloud/use-own-cloud";

/**
 * Looking at the thread reads it. A reply that lands while the app is in the background stays unread until it returns;
 * while the Mac still says unread, each new session marks again, so a mark a dropped session lost is not lost. A cloud
 * thread the phone reads through its own session is marked there, whether or not the Mac answers.
 */
export function useMarkSeen(thread: ThreadSummary | null) {
  const { mutate } = useRpcMutation("threads.update");
  const session = useSession();
  const ownCloud = useOwnCloud();
  const reached = ownCloud && thread?.owner?.brain === "hosted" ? "cloud" : session;
  useEffect(() => {
    if (!thread?.unread || reached === null) return;
    const mark = () => {
      if (AppState.currentState === "active") mutate({ id: thread.id, patch: { seen: true } });
    };
    mark();
    const subscription = AppState.addEventListener("change", (state) => state === "active" && mark());
    return () => subscription.remove();
    // A new unread reply marks again; the mutation's own status changes do not.
  }, [thread?.id, thread?.unread, thread?.lastActivityAt, reached, mutate]);
}
