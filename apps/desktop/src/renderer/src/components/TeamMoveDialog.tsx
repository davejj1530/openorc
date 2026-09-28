import { teamMoveBlockedReason, teamMoveTitle, teamMoveButton } from "../lib/team-action-presentation";
import { useRef, useState } from "react";
import type { WorkspaceMode } from "@openorc/protocol";
import { Button, Dialog } from "./ui";
import { useUi } from "../lib/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useTeamMoveRequest } from "../lib/use-team-move-request";
import { beginTeamMoveCancellation, beginTeamMoveRequest, finishTeamMoveRequest, pendingTeamMove } from "../lib/team-move-request";

/** One persistent dialog serves the header and sidebar, after their menus close. */
export function TeamMoveDialog() {
  const id = useUi((state) => state.teamMoveThreadId);
  return id ? <MoveDialog key={id} threadId={id} /> : null;
}

function MoveDialog({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  const runtime = useRpc("orchestration.runtime", { threadId });
  const move = useRpcMutation("threads.moveWorkspace");
  const cancel = useRpcMutation("threads.cancelMove");
  const saved = useTeamMoveRequest(threadId);
  const recovery = runtime.data?.actions?.moveRecovery;
  const pending = pendingTeamMove(saved.request, recovery);
  const chosenDestination = useRef<WorkspaceMode | null>(null);
  if (!chosenDestination.current && thread.data) chosenDestination.current = thread.data.workspaceMode === "current" ? "worktree" : "current";
  const to = pending?.to ?? chosenDestination.current;
  const cancelling = pending?.phase === "cancel";
  const busy = useThreadMutationPending(threadId);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const blockedReason = teamMoveBlockedReason({
    loadFailed: runtime.isError || thread.isError,
    loading: runtime.isPending || thread.isPending,
    available: Boolean(runtime.data && thread.data),
    move: runtime.data?.actions?.move,
    hasRecovery: Boolean(recovery),
    savedError: saved.error,
    hasPending: Boolean(pending),
  });
  const refresh = () => {
    saved.refresh();
    void runtime.refetch();
    void thread.refetch();
  };
  const close = () => {
    if (!busy && !inFlight.current && useUi.getState().teamMoveThreadId === threadId) useUi.getState().setTeamMoveThread(null);
  };
  const submit = async (action: "move" | "cancel") => {
    if (busy || inFlight.current || blockedReason || notice || !to) return;
    inFlight.current = true;
    setError(null);
    try {
      if (action === "cancel") {
        const request = beginTeamMoveCancellation(threadId, recovery);
        const result = await cancel.mutateAsync({ id: threadId, requestKey: request.requestKey });
        const message =
          result.state === "applied"
            ? `The move finished before cancellation. The team is now in ${request.to === "current" ? "the local checkout" : "a worktree"}.`
            : "Move cancelled. The team stays in its original workspace, and unrelated local work is kept.";
        if (!finishTeamMoveRequest(threadId, request)) throw new Error(`${message} Its local recovery record could not be cleared. Retry cancellation to confirm the same outcome.`);
        setNotice(message);
      } else {
        const request = beginTeamMoveRequest(threadId, to, recovery);
        const result = await move.mutateAsync({ id: threadId, to: request.to, requestKey: request.requestKey });
        if ("rejected" in result) {
          const cleared = finishTeamMoveRequest(threadId, request);
          const reason = result.rejected || "This move request was rejected.";
          setError(cleared ? reason : `${reason} The rejection is confirmed, but its local recovery record could not be cleared. Retry move when local storage is available.`);
          return;
        }
        if (!finishTeamMoveRequest(threadId, request)) throw new Error("The move completed, but its local recovery record could not be cleared. Retry move to confirm the same workspace change.");
        // A user can navigate while the dialog is open. A workspace change does
        // not navigate them back to its source task.
        if (useUi.getState().teamMoveThreadId === threadId) useUi.getState().setTeamMoveThread(null);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      inFlight.current = false;
      refresh();
    }
  };
  const title = teamMoveTitle({ notice, cancelling, pending: Boolean(pending), to });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={title}
    >
      <div data-team-move-dialog={threadId} data-team-move-phase={pending?.phase ?? "new"}>
        {thread.data ? <p className="text-sm text-ink-3 mb-3 break-words">{thread.data.title}</p> : null}
        {notice ? (
          <p role="status" className="text-base text-ink-2 mb-4">
            {notice}
          </p>
        ) : (
          <>
            {to ? (
              <p className="text-base text-ink-2 mb-4">
                {to === "current"
                  ? "Merge the team’s files into the local checkout. Unrelated local edits and staged changes are kept. The team conversation continues in the checkout; delegated assignments keep their isolated workspaces."
                  : "Move the team’s changes into a separate worktree. Unrelated local edits and staged changes stay in the checkout. The team conversation continues in the worktree; delegated assignments keep their isolated workspaces."}
              </p>
            ) : null}
            {pending ? (
              <p className="text-sm text-ink-3 mb-3">
                {cancelling ? "Cancellation is saved. Retry it to confirm the outcome; this will not send the move again." : "Retry confirms the saved move to the same destination."}
              </p>
            ) : (
              <p className="text-sm text-ink-3 mb-3">Moving does not start an agent.</p>
            )}
            {recovery && !cancelling ? <p className="text-sm text-ink-3 mb-3">Cancel move rolls back only this move’s recorded file changes. Unrelated local work is kept.</p> : null}
            {blockedReason ? (
              <p role="status" className="text-sm text-ink-3 mb-3">
                {blockedReason}{" "}
                <Button size="sm" variant="ghost" disabled={busy || runtime.isFetching || thread.isFetching} onClick={refresh}>
                  Refresh team status
                </Button>
              </p>
            ) : null}
            {error || recovery?.error ? (
              <p role="alert" className="text-sm text-bad mb-3 break-words">
                {error ?? recovery?.error}
              </p>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {pending || notice ? "Close" : "Cancel"}
          </Button>
          {!notice && recovery && !cancelling ? (
            <Button variant="ghost" disabled={busy || Boolean(blockedReason)} onClick={() => void submit("cancel")}>
              Cancel move
            </Button>
          ) : null}
          {!notice ? (
            <Button disabled={busy || Boolean(blockedReason) || !to} onClick={() => void submit(cancelling ? "cancel" : "move")}>
              {teamMoveButton({ cancelPending: cancel.isPending, movePending: move.isPending, cancelling, pending: Boolean(pending) })}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
