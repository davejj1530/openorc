import { threadTogether } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useMemo, useRef } from "react";
import { newId, useRpcMutation } from "../client";
import type { PhoneNote } from "./note-draft";
import type { ComposerNotes } from "./use-composer";

/**
 * Where the composer posts notes, while the server lets the reader post them in this cloud thread. A note keeps its id
 * while its words and tags stay the same, so posting it again after a lost answer is the same note.
 */
export function useComposerNotes(thread: ThreadSummary): ComposerNotes | null {
  const together = threadTogether(thread);
  const threadId = together?.canPostNote ? thread.id : null;
  const viewerId = together?.viewer?.id ?? null;
  const { mutateAsync } = useRpcMutation("threads.postNote");
  const pending = useRef<{ key: string; id: string } | null>(null);
  return useMemo(() => {
    if (!threadId) return null;
    const post = async (note: PhoneNote) => {
      const key = JSON.stringify(note);
      if (pending.current?.key !== key) pending.current = { key, id: newId() };
      await mutateAsync({ threadId, id: pending.current.id, ...note });
      pending.current = null;
    };
    return { threadId, viewerId, post };
  }, [threadId, viewerId, mutateAsync]);
}
