import { useEffect, useRef, useState } from "react";
import type { Thread } from "@openorc/protocol";
import { readDraft, writeDraft } from "../lib/drafts";
import { useRpcMutation } from "../lib/query";
import { prepareTeamSendRequest, restoreTeamSendRequest, type TeamSendRequest } from "../lib/team-send-request";
import { teamControlParams, teamTaskScope } from "../lib/team-control-scope";

/** The local draft updates immediately; the thread copy follows after typing settles. */
export function useTeamConversationDraft(thread: Pick<Thread, "id" | "draft">, retainedTaskId?: string) {
  const update = useRpcMutation("threads.update");
  const draftKey = `conversation.${thread.id}`;
  const [prompt, setText] = useState(() => readDraft(draftKey, { text: thread.draft ?? "" }).text);
  const [error, setError] = useState<string | null>(null);
  const changePrompt = (text: string) => {
    setText(text);
    writeDraft(draftKey, { text });
  };
  const mutate = update.mutate;
  useEffect(() => {
    const timer = setTimeout(
      () => mutate({ id: thread.id, ...teamTaskScope(retainedTaskId), patch: { draft: prompt || null } }, { onError: (failure) => setError(failure.message), onSuccess: () => setError(null) }),
      600,
    );
    return () => clearTimeout(timer);
  }, [prompt, thread.id, retainedTaskId, mutate]);
  return { draftKey, prompt, changePrompt, error, reportError: setError };
}

interface TeamSendInput {
  threadId: string;
  retainedTaskId?: string;
  waitForSaved: () => Promise<void>;
  changePrompt: (text: string) => void;
  reportDraftError: (error: string | null) => void;
}

/** A saved request key survives a lost response and a changed live/queue shortcut. */
export function useRecoverableTeamSend({ threadId, retainedTaskId, waitForSaved, changePrompt, reportDraftError }: TeamSendInput) {
  const send = useRpcMutation("orchestration.send");
  const requestKey = `conversation.${threadId}.send`;
  const [restoredRequest] = useState(() => restoreTeamSendRequest(readDraft(requestKey, {})));
  const request = useRef<TeamSendRequest | null>(restoredRequest);
  const submit = async (text: string, attachments: string[], now: boolean) => {
    await waitForSaved();
    const body = text || "See the attached image.";
    request.current = prepareTeamSendRequest({ previous: request.current, body, attachments, deliverNow: now });
    if (!writeDraft(requestKey, request.current)) {
      const message = "Could not save this send request for recovery. Your message is kept; retry when local storage is available.";
      reportDraftError(message);
      throw new Error(message);
    }
    await send.mutateAsync({ ...teamControlParams(threadId, retainedTaskId), text: body, attachments, requestKey: request.current.key, now: request.current.now });
    request.current = null;
    writeDraft(requestKey, {});
    changePrompt("");
  };
  return { submit, pending: send.isPending, error: send.error?.message ?? null, request: request.current, restored: Boolean(restoredRequest) };
}
