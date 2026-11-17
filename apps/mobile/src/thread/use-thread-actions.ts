import { renamedTitle } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { router } from "expo-router";
import { useMemo } from "react";
import { Alert } from "react-native";
import { useRpcMutation } from "../client";
import { openInApp } from "../ui/web";
import { DELETE_CLOUD_THREAD, type OrganizePatch, type ThreadAction } from "./thread-actions";

/** The rename prompt: the title to edit, shown in full above the field when it is too long to read there. */
function promptRename(title: string, save: (title: string) => void): void {
  Alert.prompt(
    "Rename Thread",
    title.length > 40 ? title : undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Save",
        isPreferred: true,
        onPress: (typed?: string) => {
          const next = renamedTitle(title, typed ?? "");
          if (next) save(next);
        },
      },
    ],
    "plain-text",
    title,
  );
}

/**
 * Runs a thread's menu actions against the Mac. A change the Mac refuses (a thread still working, a thread gone) says
 * why in an alert. `onUnread` hears a thread marked unread, which an open thread would read again at once.
 */
export function useThreadActions(thread: ThreadSummary | null, { onUnread, onDeleted, compact }: { onUnread?: () => void; onDeleted?: () => void; compact?: (() => Promise<unknown>) | null } = {}) {
  const { mutate } = useRpcMutation("threads.update");
  const { mutate: remove } = useRpcMutation("threads.delete");
  // Stable while the thread is, so a native menu built from `run` is not set again on every render.
  return useMemo(() => {
    const save = (patch: OrganizePatch | { title: string }) => {
      if (!thread) return;
      mutate({ id: thread.id, patch }, { onError: (failure) => Alert.alert("Couldn’t change this thread", failure.message) });
    };
    const rename = () => thread && promptRename(thread.title, (title) => save({ title }));
    const confirmDelete = (id: string) =>
      Alert.alert("Delete this thread?", DELETE_CLOUD_THREAD, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => remove({ id }, { onSuccess: onDeleted, onError: (failure) => Alert.alert("Couldn’t delete this thread", failure.message) }) },
      ]);
    const run = (action: ThreadAction) => {
      if (!thread) return;
      if (action.kind === "patch") {
        save(action.patch);
        if (action.patch.seen === false) onUnread?.();
      } else if (action.kind === "snooze") save({ snoozedUntil: action.until(new Date()) });
      else if (action.kind === "rename") rename();
      else if (action.kind === "open") openInApp(action.url);
      else if (action.kind === "parent") router.push({ pathname: "/thread/[id]", params: { id: action.threadId } });
      else if (action.kind === "screen") router.push({ pathname: action.pathname, params: { threadId: thread.id } });
      else if (action.kind === "delete") confirmDelete(thread.id);
      else if (action.kind === "compact") void compact?.().catch((failure: Error) => Alert.alert("Couldn’t compact this thread", failure.message));
    };
    return { run, save, rename };
  }, [thread, mutate, remove, onUnread, onDeleted, compact]);
}
