import { renamedTitle } from "@openorc/client";
import type { RpcParams, Task } from "@openorc/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { useRpcMutation } from "../client";
import { neverSent } from "../connection/link-connection";
import { haptic } from "../ui/haptics";

export type TaskPatch = RpcParams<"tasks.update">["patch"];

/** The read `useRpc("tasks.get", { id })` keeps, so a saved task shows at once, before the Mac's refresh lands. */
export const taskKey = (id: string) => ["tasks.get", { id }] as const;

/** A phone reads a description with its secrets redacted; one that shows a redaction is edited on the Mac. */
export const holdsSecret = (spec: string | null): boolean => spec !== null && /\[redacted:[\w-]+\]/.test(spec);
export const SECRET_SPEC = "This description holds a secret, so edit it on your Mac.";

/** A title as typed, made one line; null when it is empty or unchanged. */
export const typedTitle = (current: string, typed: string): string | null => renamedTitle(current, typed.replace(/\s*\n\s*/g, " "));

/** Labels typed comma separated, trimmed, each once, in the order typed. */
export const typedLabels = (typed: string): string[] => [...new Set(typed.split(",").map((label) => label.trim()))].filter(Boolean);

/** What a task reads as while a change is on its way to the Mac. */
type Shown = Partial<Task>;

/** Saves a change to a task; `shows` is how the task reads meanwhile, when that is more than the patch says. */
export type SaveTask = (patch: TaskPatch, shows?: Shown) => void;

/** Drops the fields `shows` set from `pending`, unless a newer edit has set them since. */
function settled(pending: Shown, shows: Shown): Shown {
  const left: Record<string, unknown> = { ...pending };
  for (const [key, value] of Object.entries(shows)) if (left[key] === value) delete left[key];
  return left;
}

/**
 * What the alert says of a change that was not saved: the Mac's reason. A move the Mac never heard says so plainly, as
 * a task put in a column there starts that column's agent.
 */
export function saveFailure(patch: TaskPatch, error: Error): { title: string; message: string } {
  const moves = patch.status !== undefined || patch.columnId !== undefined;
  if (moves && neverSent(error)) return { title: "Your Mac can’t be reached", message: "The task did not move, so no automation will start." };
  return { title: "Couldn’t save the task", message: error.message };
}

/**
 * Edits one task on its host: each change shows at once, is saved with `tasks.update`, and shows the Mac's answer when
 * it comes. A change the Mac refuses goes back, and an alert says why.
 */
export function useTaskEdit(task: Task | null | undefined) {
  const queryClient = useQueryClient();
  const { mutate } = useRpcMutation("tasks.update");
  const [pending, setPending] = useState<Shown>({});
  const id = task?.id;
  const save = useCallback<SaveTask>(
    (patch, shows = patch) => {
      if (!id) return;
      setPending((before) => ({ ...before, ...shows }));
      mutate(
        { id, patch },
        {
          onSuccess: (saved) => queryClient.setQueryData(taskKey(id), saved),
          onError: (error) => {
            haptic.warn();
            const { title, message } = saveFailure(patch, error);
            Alert.alert(title, message);
          },
          onSettled: () => setPending((before) => settled(before, shows)),
        },
      );
    },
    [id, mutate, queryClient],
  );
  return { shown: task ? { ...task, ...pending } : null, save };
}

/**
 * Descriptions being written, kept for the app's life so a sheet swiped away by mistake opens on them again. A draft
 * counts only while the description it started from is still the Mac's.
 */
const drafts = new Map<string, { base: string; text: string }>();
export const descriptionDrafts = {
  get: (id: string, base: string): string | null => {
    const draft = drafts.get(id);
    return draft && draft.base === base ? draft.text : null;
  },
  set: (id: string, base: string, text: string) => void drafts.set(id, { base, text }),
  clear: (id: string) => void drafts.delete(id),
};
