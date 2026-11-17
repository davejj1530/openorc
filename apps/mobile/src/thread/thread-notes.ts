import { threadTogether } from "@openorc/client";
import type { ThreadCollaboration, ThreadNote, ThreadSummary } from "@openorc/protocol";
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useRpc, useRpcMutation } from "../client";
import type { ComposerHandle } from "../composer/Composer";

/** The most notes one read brings, the newest. */
const NOTES_PER_READ = 200;
/** The most notes one mark reads, as the server takes them. */
const MOST_READ = 100;
/** How long the marks of notes seen together wait, so one scroll marks them in one call. */
const READ_DELAY = 400;

const NONE: readonly ThreadNote[] = [];

/**
 * A cloud thread's notes, once it has any: the newest, and those around the reader's first unread mention however far
 * back it is, each note once in `seq` order. None for any other thread.
 */
export function useThreadNotes(thread: ThreadSummary | null | undefined): readonly ThreadNote[] {
  const collaboration = threadTogether(thread);
  const threadId = thread?.id ?? "";
  const noted = (collaboration?.noteHead ?? 0) > 0;
  const mention = collaboration?.mentions.firstUnreadNoteId ?? null;
  const newest = useRpc("threads.notes", { threadId, limit: NOTES_PER_READ }, { enabled: noted });
  const around = useRpc("threads.notes", { threadId, around: mention ?? "", limit: NOTES_PER_READ }, { enabled: noted && mention !== null });
  return useMemo(() => {
    const pages = [newest.data?.notes, mention ? around.data?.notes : undefined].flatMap((page) => page ?? []);
    if (!pages.length) return NONE;
    return [...new Map(pages.map((note) => [note.id, note])).values()].sort((a, b) => a.seq - b.seq);
  }, [newest.data, around.data, mention]);
}

/**
 * What marks read the notes that tag the reader once they have been on screen: the ids seen together go in one call of
 * at most a hundred; a note whose mark failed goes again the next time it is seen.
 */
export function useNoteReading(threadId: string): (ids: readonly string[]) => void {
  const { mutateAsync } = useRpcMutation("threads.readNotes");
  const waiting = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flush = useCallback(() => {
    timer.current = null;
    const ids = [...waiting.current].slice(0, MOST_READ);
    ids.forEach((id) => {
      waiting.current.delete(id);
      sent.current.add(id);
    });
    if (waiting.current.size) timer.current = setTimeout(flush, READ_DELAY);
    void mutateAsync({ threadId, ids }).catch(() => ids.forEach((id) => sent.current.delete(id)));
  }, [mutateAsync, threadId]);
  return useCallback(
    (ids) => {
      for (const id of ids) if (!sent.current.has(id)) waiting.current.add(id);
      if (waiting.current.size && !timer.current) timer.current = setTimeout(flush, READ_DELAY);
    },
    [flush],
  );
}

/**
 * The reader's first unread mention as the thread opened, which it opens at. It stays while the thread stays open, so
 * reading it, or a note that comes later, never moves the view.
 */
export function useMentionOpening(thread: ThreadSummary | null | undefined): string | null {
  const first = threadTogether(thread)?.mentions.firstUnreadNoteId ?? null;
  const [opening, setOpening] = useState<{ threadId: string; noteId: string | null } | null>(null);
  if (thread && opening?.threadId !== thread.id) {
    setOpening({ threadId: thread.id, noteId: first });
    return first;
  }
  return opening?.noteId ?? null;
}

/** Reply on a note, for the reader who may post notes: a note back to its author, never to the reader's own. */
export interface NoteReply {
  viewerId: string | null;
  reply: (note: ThreadNote) => void;
}

export const NoteReplyContext = createContext<NoteReply | null>(null);

/** Reply on the thread's notes, which tags the note's author at the start of the composer's draft; none where the reader cannot post notes. */
export function useNoteReply(together: ThreadCollaboration | null): { handle: RefObject<ComposerHandle | null>; value: NoteReply | null } {
  const handle = useRef<ComposerHandle>(null);
  const viewerId = together?.viewer?.id ?? null;
  const canPost = Boolean(together?.canPostNote);
  const value = useMemo(
    () =>
      canPost
        ? {
            viewerId,
            reply: (note: ThreadNote) => note.author && handle.current?.tag({ id: note.author.id, name: note.author.name }, { noteId: note.id, authorId: note.author.id }),
          }
        : null,
    [canPost, viewerId],
  );
  return { handle, value };
}
