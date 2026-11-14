import { useEffect } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "./client";

/** Looking at a conversation reads it. A reply that lands while the window is elsewhere stays unread until the person comes back. */
export function useReadWhileShown(thread: Pick<ThreadSummary, "id" | "unread" | "lastActivityAt"> | null | undefined) {
  const update = useRpcMutation("threads.update");
  useEffect(() => {
    if (!thread?.unread) return;
    const mark = () => {
      if (document.hasFocus()) update.mutate({ id: thread.id, patch: { seen: true } });
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Resubscribe on new unread activity, not on this effect's own seen-mutation status updates.
  }, [thread?.id, thread?.unread, thread?.lastActivityAt]);
}
