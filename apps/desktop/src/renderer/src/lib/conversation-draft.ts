import { useCallback, useEffect, useRef, useState } from "react";
import { readDraft, removeDraft, writeDraft } from "./drafts";
import { useRpcMutation } from "./query";

/** The local copy survives navigation; the delayed server copy follows it. */
export function useConversationDraft({ draftKey, threadId, initialText }: { draftKey: string; threadId: string | null; initialText: string }) {
  const [prompt, updatePrompt] = useState(() => readDraft(draftKey, { text: initialText }).text);
  const update = useRpcMutation("threads.update");
  const persistDraft = update.mutate;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedText = useRef(initialText);
  const setPrompt = useCallback(
    (text: string) => {
      updatePrompt(text);
      writeDraft(draftKey, { text });
    },
    [draftKey],
  );

  useEffect(() => {
    if (!threadId) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (prompt === savedText.current) return;
      savedText.current = prompt;
      persistDraft({ id: threadId, patch: { draft: prompt || null } });
    }, 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [prompt, threadId, persistDraft]);

  const clearDraft = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setPrompt("");
    removeDraft(draftKey);
    savedText.current = "";
    if (threadId) persistDraft({ id: threadId, patch: { draft: null } });
  }, [draftKey, threadId, setPrompt, persistDraft]);

  return { prompt, setPrompt, clearDraft, error: update.error };
}
