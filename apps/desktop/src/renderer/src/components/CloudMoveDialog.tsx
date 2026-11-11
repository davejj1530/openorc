import { useState, type ReactNode } from "react";
import { FileRows } from "../panels/FileRows";
import { Button, Dialog } from "./ui";
import { useUi } from "../lib/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { machine, thisComputer } from "../lib/this-computer";

/** What a checkout conversation takes with it: the files that leave the checkout, or why it cannot move. */
function useCheckoutPreview(threadId: string, enabled: boolean): { blocked: string | null; pending: boolean; contents: ReactNode } {
  const preview = useRpc("threads.movePreview", { id: threadId, to: "worktree" }, { enabled, staleTime: 0 });
  if (!enabled) return { blocked: null, pending: false, contents: null };
  const blocked = preview.data?.blocked ?? (preview.isError ? preview.error.message : null);
  const files = preview.data?.files ?? [];
  if (preview.isPending)
    return {
      blocked,
      pending: true,
      contents: (
        <p role="status" className="text-sm text-ink-3 mb-3">
          Checking what will move…
        </p>
      ),
    };
  return {
    blocked,
    pending: false,
    contents: files.length ? (
      <div className="mb-3 overflow-hidden rounded-xl bg-surface-2">
        <FileRows files={files} />
      </div>
    ) : null,
  };
}

function moveWords(fromCheckout: boolean, brain: boolean): string {
  const checkout = "Every uncommitted change in the checkout first moves into a new worktree on its own branch, including changes you or other conversations made. ";
  if (brain)
    return `${fromCheckout ? checkout : ""}Its history, session, branch and uncommitted changes go to your cloud brain, where it carries on while ${thisComputer} sleeps. Its worktree leaves ${thisComputer}; Bring to ${machine} brings it back.`;
  return fromCheckout
    ? `${checkout}That worktree and the conversation’s session then go to a sandbox of its own, where its next message runs.`
    : `Its worktree, uncommitted changes and session go to a sandbox of its own, where its next message runs. The worktree stays on ${thisComputer} and follows the sandbox.`;
}

/**
 * One confirm for moving a conversation from this Mac to a sandbox of its own. A conversation in the checkout lists
 * the files that leave the checkout with it, as moving it to a worktree does.
 */
export function CloudMoveDialog({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  const brain = Boolean(useRpc("cloud.offer", {}).data?.brain);
  const fromCheckout = thread.data?.workspaceMode === "current";
  const preview = useCheckoutPreview(threadId, fromCheckout);
  const move = useRpcMutation("cloud.move");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!move.isPending) useUi.getState().setMoveThread(null);
  };
  const submit = async () => {
    if (move.isPending) return;
    setError(null);
    try {
      await move.mutateAsync({ threadId });
      useUi.getState().setMoveThread(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const problem = error ?? preview.blocked;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())} title="Move this conversation to the cloud?" width={520}>
      <div>
        {thread.data ? <p className="text-sm text-ink-3 mb-3 break-words">{thread.data.title}</p> : null}
        <p className="text-base text-ink-2 mb-3">{moveWords(fromCheckout, brain)}</p>
        {preview.contents}
        {problem ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {problem}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={move.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={move.isPending || Boolean(preview.blocked) || preview.pending || !thread.data} onClick={() => void submit()}>
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
