import type { HostedFileScope, OnlineTaskThreadDraft } from "@openorc/protocol";
import type { SubmitRequest } from "@openorc/client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readDraft } from "./drafts";
import { organizationContentGate } from "./organization-content-gate";
import { acceptStoredTask, hostedConversationDraftKey, insertStoredTask, preparedTaskDraft, preparedTaskFor, subscribeTaskDraft, taskDraftSnapshot } from "./task-thread-storage";

interface Input {
  scope: HostedFileScope | null;
  threadId: string | null;
  draftKey: string;
  prompt: string;
  setPrompt(text: string): void;
}
interface TaskComposerDraft {
  task: SubmitRequest["task"];
  prepared: boolean;
  blocked: string | null;
  insert: (() => void) | undefined;
  accepted(text: string): boolean;
}
export function useTaskComposerDraft({ scope, threadId, draftKey, prompt, setPrompt }: Input): TaskComposerDraft {
  const subscribe = useCallback((change: () => void) => subscribeTaskDraft(draftKey, change), [draftKey]);
  const snapshot = useCallback(() => taskDraftSnapshot(draftKey), [draftKey]);
  const saved = useSyncExternalStore(subscribe, snapshot);
  const stored = scope && preparedTaskDraft(draftKey);
  const task = taskForComposer(scope, threadId, draftKey);
  const ticket = scope && organizationContentGate.capture(scope.spaceId, scope.accountId);
  const blocked = stored && (!task || !ticket?.current()) ? "This prepared task isn't available. Open its task again." : null;
  useEffect(() => {
    if (!scope || !saved) return;
    const text = readDraft(draftKey, { text: prompt }).text;
    if (typeof text === "string" && text !== prompt) setPrompt(text);
  }, [scope, saved, draftKey, prompt, setPrompt]);
  return {
    task: task && !blocked ? { context: { id: task.reference.id, ifRevision: task.ifRevision }, requestId: task.requestId } : undefined,
    prepared: Boolean(stored),
    blocked,
    insert:
      task && !task.inserted && !blocked
        ? () => {
            if (!ticket?.current()) return;
            setPrompt(insertStoredTask(draftKey, task, prompt));
          }
        : undefined,
    accepted(text) {
      if (!task) return false;
      if (!ticket?.current()) return true;
      const next = acceptStoredTask(draftKey, task, text);
      if (next !== null) setPrompt(next);
      return true;
    },
  };
}

function taskForComposer(scope: HostedFileScope | null, threadId: string | null, draftKey: string): OnlineTaskThreadDraft | null {
  if (!scope || !threadId || scope.destination.kind !== "hosted") return null;
  const task = preparedTaskFor(scope, threadId);
  if (scope.destination.projectId !== task?.reference.projectId || scope.destination.threadId !== threadId) return null;
  return draftKey === hostedConversationDraftKey(scope, threadId) ? task : null;
}
