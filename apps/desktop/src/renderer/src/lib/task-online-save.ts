import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { TaskSaveController } from "./task-save-conflict";
import { useTaskOnlineMutation } from "./task-online-query";
import { keepTaskDraftRevision, recoveredTaskRevision } from "./task-draft-revision";
import { taskRefKey } from "./task-ref";
import { validateOnlineTaskSpec } from "./task-online-spec";

export function useTaskOnlineSave(reference: OnlineTaskRef, task: OnlineTask) {
  const storageId = taskRefKey(reference);
  const mutation = useTaskOnlineMutation("tasks.online.update");
  const write = useRef(mutation.mutateAsync);
  write.current = mutation.mutateAsync;
  const [controller] = useState(
    () =>
      new TaskSaveController(
        reference,
        task,
        async (input) => {
          validateOnlineTaskSpec(input.patch.spec);
          return write.current(input);
        },
        recoveredTaskRevision(storageId, task),
      ),
  );
  useEffect(() => {
    controller.observe(task);
  }, [controller, task]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    keepTaskDraftRevision(storageId, controller.draftRevision);
  }, [controller, state, storageId]);
  return {
    controller,
    state,
    pending: mutation.isPending,
    edited: () => {
      controller.markEdited();
      keepTaskDraftRevision(storageId, controller.draftRevision);
    },
    clean: () => {
      controller.markClean();
      keepTaskDraftRevision(storageId, null);
    },
  };
}
