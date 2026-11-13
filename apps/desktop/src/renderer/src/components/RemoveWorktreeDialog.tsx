import { useState } from "react";
import { useRpc, useRpcMutation } from "../lib/client";
import { useUi } from "../lib/ui";
import { Button, Dialog } from "./ui";

/** What removing a worktree keeps and what it deletes, said once wherever removal is confirmed. */
export const WORKTREE_REMOVAL_NOTE =
  "Uncommitted changes are committed to the branch first. The branch and the conversation stay, and the worktree returns on the next message. Files Git ignores in the folder, such as installed dependencies, are deleted.";

/** The thread menu's confirm for removing one conversation's worktree. */
export function RemoveWorktreeDialog() {
  const id = useUi((state) => state.removeWorktreeThreadId);
  return id ? <RemoveDialog key={id} threadId={id} /> : null;
}

function RemoveDialog({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  const remove = useRpcMutation("worktrees.remove");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!remove.isPending) useUi.getState().setRemoveWorktree(null);
  };
  const submit = async () => {
    if (remove.isPending) return;
    setError(null);
    try {
      const result = await remove.mutateAsync({ owners: [{ kind: "thread", id: threadId }] });
      const failure = result.failed[0];
      if (failure) setError(failure.message);
      else useUi.getState().setRemoveWorktree(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())} title="Remove this worktree?" width={480}>
      <div>
        {thread.data ? <p className="text-sm text-ink-3 mb-3 break-words">{thread.data.title}</p> : null}
        <p className="text-base text-ink-2 mb-3">{WORKTREE_REMOVAL_NOTE}</p>
        {error ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={remove.isPending} onClick={() => void submit()}>
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
