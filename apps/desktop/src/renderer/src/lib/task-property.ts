import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useTaskOnlineMutation } from "./task-online-query";
import { TaskSaveController } from "./task-save-conflict";

export function useTaskProperty(reference: OnlineTaskRef, task: OnlineTask) {
  const update = useTaskOnlineMutation(reference, "tasks.online.update");
  const write = useRef(update.mutateAsync);
  write.current = update.mutateAsync;
  const [controller] = useState(() => new TaskSaveController(reference, task, (input) => write.current(input)));
  useEffect(() => controller.observe(task), [controller, task]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state, pending: update.isPending };
}
