import { refineChoice, threadModelOptions } from "@openorc/client";
import { commentRecipientKey, harnessLoggedIn, TASK_WORK, type CommentMentionOption, type CommentRecipient, type TaskRefine, type TaskSuggestion } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { storage, useRpc, useRpcMutation } from "../client";
import { useShares } from "../connection/use-shares";
import { haptic } from "../ui/haptics";
import { taskKey } from "./task-edit";

const REMEMBERED = "taskRefine.recipient";

/** Whether the Mac lists a task's threads, runs its buttons and refines it for a phone. */
export const useTaskWork = (): boolean => useShares(TASK_WORK) === true;

/** The models that can refine a task: those of the agents signed in on the Mac that can run in Plan, named as the Mac names them. */
export function useRefiners(): { options: CommentMentionOption[]; chosen: CommentMentionOption | undefined; choose: (key: string) => void } {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 }).data;
  const harnesses = useRpc("agents.availability", {}, { staleTime: 60_000 }).data;
  const settings = useRpc("app.settings.get", {}).data;
  const [picked, setPicked] = useState<string | null>(() => storage.getString(REMEMBERED) ?? null);
  const options = useMemo(() => threadModelOptions(models, harnesses && new Set(harnesses.filter(harnessLoggedIn).map((row) => row.id)), true), [models, harnesses]);
  const key = refineChoice(options, models, settings?.defaultHarness ?? null, picked);
  return {
    options,
    chosen: options.find((option) => commentRecipientKey(option.recipient) === key),
    choose: (next) => {
      storage.set(REMEMBERED, next);
      setPicked(next);
    },
  };
}

/** Who refined, as the bar names them: the model as the Mac names it, or the Orcling. */
export function useRefinerName(recipient: CommentRecipient | undefined): string {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 }).data;
  const chats = useRpc("orclings.chats", {}, { enabled: Boolean(recipient?.orclingId) }).data;
  if (!recipient) return "";
  if (recipient.orclingId) return chats?.find((chat) => chat.id === recipient.orclingId)?.name ?? "The Orcling";
  const key = commentRecipientKey(recipient);
  return threadModelOptions(models, undefined, false).find((option) => commentRecipientKey(option.recipient) === key)?.name ?? recipient.model;
}

/**
 * A task's Refine as the phone follows it: the one running, or the suggestion waiting, read again while it runs.
 * Using a suggestion is an edit of the task like any other, after which the suggestion is put away.
 */
export function useTaskRefine(taskId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useRpc("tasks.refine.get", { taskId }, { enabled, refetchInterval: (read) => (read.state.data?.state === "running" ? 2000 : false) });
  const stop = useRpcMutation("tasks.refine.stop");
  const dismiss = useRpcMutation("tasks.refine.dismiss");
  const update = useRpcMutation("tasks.update");
  // Put away at once: the read that confirms it would otherwise show the suggestion a moment longer.
  const [putAway, setPutAway] = useState<string | null>(null);
  const refine: TaskRefine | null = query.data && query.data.state !== "cancelled" && query.data.id !== putAway ? query.data : null;
  const close = () => {
    if (!refine) return;
    setPutAway(refine.id);
    dismiss.mutate({ taskId }, { onError: () => setPutAway(null) });
  };
  return {
    refine,
    failure: stop.error?.message ?? dismiss.error?.message ?? update.error?.message ?? null,
    stopping: stop.isPending,
    closing: dismiss.isPending || update.isPending,
    stop: () => stop.mutate({ taskId }),
    close,
    /** Makes the suggestion the task's title, description and labels, then puts it away. */
    use: (suggestion: TaskSuggestion) =>
      update.mutate(
        { id: taskId, patch: { title: suggestion.title.trim(), spec: suggestion.description.trim() ? suggestion.description : null, labels: suggestion.labels } },
        {
          onSuccess: (saved) => {
            queryClient.setQueryData(taskKey(taskId), saved);
            haptic.confirm();
            close();
          },
          onError: () => haptic.warn(),
        },
      ),
  };
}

export type TaskRefineView = ReturnType<typeof useTaskRefine>;
