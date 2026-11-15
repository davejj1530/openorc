import { personFirst, threadTogether } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpc } from "./client";

/**
 * A row's words for the reader's first unread mention in the thread, "Mara mentioned you", read from that one note;
 * null with none, or until the note is read. Reading it marks nothing read.
 */
export function useMentionWords(thread: Pick<ThreadSummary, "id" | "owner">): string | null {
  const mentions = threadTogether(thread)?.mentions;
  const id = mentions?.unread ? mentions.firstUnreadNoteId : null;
  const read = useRpc("threads.notes", { threadId: thread.id, around: id ?? "", limit: 1 }, { enabled: id !== null, staleTime: 60_000 });
  const note = id ? read.data?.notes?.find((each) => each.id === id) : undefined;
  return note ? `${personFirst(note.author)} mentioned you` : null;
}
