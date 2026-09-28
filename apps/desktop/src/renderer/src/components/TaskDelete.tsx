import { useState } from "react";
import type { Task } from "@openorc/protocol";
import { Trash2 } from "./icons";
import { Button, Dialog, TextButton } from "./ui";
import { useRpcMutation } from "../lib/query";
import { useRouter } from "../lib/router";

/** Deletes an ordinary task and its discussion. Its conversation keeps its messages, its worktree and its changes. */
export function TaskDelete({ task }: { task: Task }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useRpcMutation("tasks.delete");
  const confirm = () =>
    remove.mutate(
      { id: task.id },
      {
        onSuccess: () => {
          setConfirming(false);
          useRouter.getState().navigate({ view: "tasks" });
        },
      },
    );
  return (
    <>
      <TextButton tone="muted" className="flex items-center gap-2 mt-6 text-sm" onClick={() => setConfirming(true)}>
        <Trash2 size={13} /> Delete task
      </TextButton>
      <Dialog open={confirming} onOpenChange={setConfirming} title="Delete this task?">
        <p className="text-base text-ink-2 mb-3">The task and its discussion disappear from OpenOrc. Its conversation keeps its messages and changes.</p>
        {remove.error ? <div className="text-sm text-bad mb-3">{remove.error.message}</div> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={confirm}>
            Delete
          </Button>
        </div>
      </Dialog>
    </>
  );
}
