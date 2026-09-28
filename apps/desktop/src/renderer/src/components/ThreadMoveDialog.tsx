import { useRef, useState, type ReactNode } from "react";
import type { WorkspaceMode } from "@openorc/protocol";
import { FileRows } from "../panels/FileRows";
import { Button, Dialog } from "./ui";
import { useUi } from "../lib/ui";
import { useRpc, useRpcMutation } from "../lib/query";

/** One confirm for moving a conversation, listing the files that go with it. Team conversations use TeamMoveDialog. */
export function ThreadMoveDialog() {
  const id = useUi((state) => state.moveThreadId);
  return id ? <MoveDialog key={id} threadId={id} /> : null;
}

function MoveDialog({ threadId }: { threadId: string }) {
  const thread = useRpc("threads.get", { id: threadId });
  // The destination is fixed when the dialog opens, so a finished move never flips it.
  const destination = useRef<WorkspaceMode | null>(null);
  if (!destination.current && thread.data) destination.current = thread.data.workspaceMode === "worktree" ? "current" : "worktree";
  const to = destination.current;
  const preview = useRpc("threads.movePreview", { id: threadId, to: to ?? "worktree" }, { enabled: Boolean(to), staleTime: 0 });
  const move = useRpcMutation("threads.moveWorkspace");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!move.isPending) useUi.getState().setMoveThread(null);
  };
  const submit = async () => {
    if (!to || move.isPending) return;
    setError(null);
    try {
      const result = await move.mutateAsync({ id: threadId, to });
      if ("rejected" in result) setError(result.rejected);
      else useUi.getState().setMoveThread(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      void preview.refetch();
    }
  };
  const blocked = preview.data?.blocked ?? (preview.isError ? preview.error.message : null);
  const files = preview.data?.files ?? [];
  let previewContents: ReactNode = null;
  if (preview.isPending && to)
    previewContents = (
      <p role="status" className="text-sm text-ink-3 mb-3">
        Checking what will move…
      </p>
    );
  else if (files.length)
    previewContents = (
      <div className="mb-3 rounded-md border border-line">
        <FileRows files={files} />
      </div>
    );
  else if (!blocked) previewContents = <p className="text-sm text-ink-3 mb-3">No uncommitted changes. Only the conversation moves.</p>;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())} title={to === "current" ? "Move this conversation to the checkout?" : "Move this conversation to a worktree?"} width={520}>
      <div className="px-4 py-3">
        {thread.data ? <p className="text-sm text-ink-3 mb-3 break-words">{thread.data.title}</p> : null}
        <p className="text-base text-ink-2 mb-3">
          {to === "current"
            ? "The worktree’s changes merge into the checkout’s files, and the worktree is removed. Its branch stays, with any commits made on it. Nothing is staged."
            : "Every uncommitted change in the checkout moves into a new worktree on its own branch, including changes you or other conversations made. Those files in the checkout go back to its last commit."}
        </p>
        {previewContents}
        {blocked ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {blocked}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-ink-3 mb-3">Moving does not start an agent. If a file changes while it moves, nothing is taken from where it was.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={move.isPending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={move.isPending || preview.isPending || Boolean(blocked) || !to} onClick={() => void submit()}>
            {move.isPending ? "Moving…" : "Move"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
