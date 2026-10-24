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

/**
 * What the person is writing in a thread, kept on the phone per Mac and thread as they type, so leaving the thread or
 * the app keeps it. A send clears it only once the Mac took the message.
 */
export function useDraft(threadId: string): [Draft, (update: (draft: Draft) => Draft) => void] {
  const [draft, setDraft] = useState(() => read(threadId));
  const update = useCallback(
    (change: (draft: Draft) => Draft) =>
      setDraft((current) => {
        const next = change(current);
        if (next.text || next.images.length) storage.set(keyOf(threadId), JSON.stringify(next));
        else storage.remove(keyOf(threadId));
        return next;
      }),
    [threadId],
  );
  return [draft, update];
}
