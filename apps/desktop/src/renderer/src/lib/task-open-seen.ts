import { useEffect, useRef } from "react";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useTaskOnlineMutation } from "./task-online-query";

/** Visibility in a list is never an acknowledgement; the mounted Overview names one generation. */
export function useTaskOpenSeen(reference: OnlineTaskRef, task: OnlineTask, open: boolean) {
  const seen = useTaskOnlineMutation(reference, "tasks.online.seen");
  const attempted = useRef<number | null>(null);
  const write = useRef(seen.mutate);
  write.current = seen.mutate;
  useEffect(() => {
    if (!open || !task.viewer.unseenAssignment || attempted.current === task.assignmentRevision) return;
    attempted.current = task.assignmentRevision;
    write.current({ spaceId: reference.spaceId, id: reference.id, requestId: crypto.randomUUID(), assignmentRevision: task.assignmentRevision });
  }, [open, reference.spaceId, reference.id, task.viewer.unseenAssignment, task.assignmentRevision]);
  return seen;
}
