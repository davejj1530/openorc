import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcResults } from "@openorc/protocol";
import { conversationDraftKey, readDraft, removeDraft, writeDraft } from "./drafts";
import { queryClient, useRpcMutation } from "./client";

const DRAFT_ADDED = "openorc:conversation-draft-added";
type DraftAdded = { key: string; text: string };

/**
 * Adds a message to a thread's message box: after what this window typed there, else the box opens on `draft`, the
 * thread's saved draft with the message in it. A message box showing the thread takes it at once.
 */
export function addToConversationDraft(threadId: string, message: string, draft: string): void {
  const key = conversationDraftKey(threadId);
  const here = readDraft<{ text: string } | null>(key, null);
  let text = draft;
  if (here?.text.trim()) {
    text = `${here.text}\n\n${message}`;
    writeDraft(key, { ...here, text });
  } else {
    // No copy here, which would outlive the draft once the task starts another way and the core sends and clears it.
    removeDraft(key);
    queryClient.setQueryData<RpcResults["threads.get"]>(["threads.get", { id: threadId }], (thread) => thread && { ...thread, draft });
  }
  window.dispatchEvent(new CustomEvent<DraftAdded>(DRAFT_ADDED, { detail: { key, text } }));
}

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
      writeDraft(draftKey, { ...readDraft(draftKey, { text }), text });
    },
    [draftKey],
  );

  useEffect(() => {
    const take = (event: Event) => {
      const added = (event as CustomEvent<DraftAdded>).detail;
      if (added.key === draftKey) updatePrompt(added.text);
    };
    window.addEventListener(DRAFT_ADDED, take);
    return () => window.removeEventListener(DRAFT_ADDED, take);
  }, [draftKey]);

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
