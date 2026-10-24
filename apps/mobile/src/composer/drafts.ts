import { useCallback, useState } from "react";
import { shownMacId, storage } from "../client";

/** An image in a draft: where the Mac saved it, and the resized copy the phone shows. */
export interface DraftImage {
  path: string;
  preview: string;
}

export interface Draft {
  text: string;
  images: DraftImage[];
}

const EMPTY: Draft = { text: "", images: [] };
const keyOf = (threadId: string) => `draft.${shownMacId() ?? "none"}.${threadId}`;

function read(threadId: string): Draft {
  try {
    const saved = storage.getString(keyOf(threadId));
    return saved ? { ...EMPTY, ...(JSON.parse(saved) as Partial<Draft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function write(threadId: string, draft: Draft): void {
  if (draft.text || draft.images.length) storage.set(keyOf(threadId), JSON.stringify(draft));
  else storage.remove(keyOf(threadId));
}

/**
 * What the person is writing in a thread, kept on the phone per Mac and thread as they type, so leaving the thread or
 * the app keeps it. A send empties it at once; a send the Mac refuses puts back what it took.
 */
export function useDraft(threadId: string): [Draft, (update: (draft: Draft) => Draft) => void] {
  const [draft, setDraft] = useState(() => read(threadId));
  const update = useCallback(
    (change: (draft: Draft) => Draft) => {
      // The saved draft is the one to change: an image or a send can land after the reader swiped back.
      const next = change(read(threadId));
      write(threadId, next);
      setDraft(next);
    },
    [threadId],
  );
  return [draft, update];
}
