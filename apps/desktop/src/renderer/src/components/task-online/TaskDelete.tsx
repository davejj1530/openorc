import { useRef, useState } from "react";
import type { OnlineTask, OnlineTaskParams } from "@openorc/protocol";
import { useTaskOnlineMutation } from "../../lib/task-online-query";
import { useRouter } from "../../lib/router";
import { Trash2 } from "../icons";
import { Button, Dialog, TextButton, Tooltip } from "../ui";

export function TaskOnlineDelete({ task, beforeDelete, getTask, pending }: { task: OnlineTask; beforeDelete(): Promise<boolean>; getTask(): OnlineTask; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState(false);
  const request = useRef<OnlineTaskParams<"tasks.online.delete"> | null>(null);
  const remove = useTaskOnlineMutation("tasks.online.delete");
  if (!task.viewer.mayDelete) return null;
  const reason = task.viewer.liveExecution ? "Wait for this task’s current turn to finish before deleting it." : undefined;
  const confirm = async () => {
    if (!(await beforeDelete())) return;
    const current = getTask();
    if (!current.viewer.mayDelete || current.viewer.liveExecution) return;
    request.current ??= { spaceId: current.spaceId, id: current.id, requestId: crypto.randomUUID(), ifRevision: current.revision };
    const route = useRouter.getState().route;
    remove.mutate(request.current, {
      onSuccess: (result) => {
        if (result.state === "conflict") {
          setConflict(true);
          request.current = null;
          return;
        }
        if (route === useRouter.getState().route) useRouter.getState().navigate({ view: "tasks" });
      },
    });
  };
  return (
    <>
      <Tooltip label={reason}>
        <TextButton tone="muted" className="flex items-center gap-2 mt-6 text-sm" disabled={Boolean(reason) || pending} onClick={() => setConfirming(true)}>
          <Trash2 size={13} />
          Delete task
        </TextButton>
      </Tooltip>
      <Dialog open={confirming} onOpenChange={setConfirming} title="Delete this task?">
        <p className="text-base text-ink-2 mb-3">The task disappears from this project. Its thread keeps its messages and changes.</p>
        {conflict ? (
          <p className="text-sm text-bad mb-3" role="alert">
            This task changed. Review it before deleting.
          </p>
        ) : null}
        {remove.error ? (
          <p className="text-sm text-bad mb-3" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            onClick={() => {
              setConfirming(false);
              setConflict(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending || pending || Boolean(reason) || conflict} onClick={() => void confirm()}>
            Delete
          </Button>
        </div>
      </Dialog>
    </>
  );
}
