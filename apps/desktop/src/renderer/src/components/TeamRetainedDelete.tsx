import { deleteButtonLabel } from "../lib/team-action-presentation";
import { useRef, useState } from "react";
import type { TeamTaskView } from "@openorc/protocol";
import { TeamRecoveryActions } from "./TeamRecoveryActions";
import { Button } from "./ui";
import { useRpcMutation } from "../lib/query";
import { beginTeamDeleteRequest, finishTeamDeleteRequest } from "../lib/team-delete-request";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useTeamDeleteRequest } from "../lib/use-team-delete-request";

type OwnerDeletion = NonNullable<TeamTaskView["deleteOwner"]>;

/** Deleting a deleted conversation's saved tasks is one durable request against the hidden owner, keyed like a team delete. */
export function DeleteRetainedOwnerContent({ threadId, deletion, close, onDeleted }: { threadId: string; deletion: OwnerDeletion; close: () => void; onDeleted: () => void }) {
  const saved = useTeamDeleteRequest(threadId);
  const remove = useRpcMutation("threads.delete");
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const busy = useThreadMutationPending(threadId);
  const count = deletion.taskIds.length;
  const pending = deletion.recovery ?? saved.request;
  const blocked = retainedDeleteBlockedReason(deletion, saved.error);
  const run = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      const request = beginTeamDeleteRequest(threadId, deletion.recovery);
      const result = await remove.mutateAsync({ id: threadId, requestKey: request.requestKey });
      finishTeamDeleteRequest(threadId, request);
      if (result && "rejected" in result) {
        setFailure(result.rejected || "This delete request was rejected.");
        return;
      }
      close();
      onDeleted();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  };
  const error = failure ?? deletion.recovery?.error ?? null;
  return (
    <>
      <p className="text-base text-ink-2 mb-3" data-team-final-delete={threadId}>
        {count === 1 ? "This is the last saved task of a deleted conversation." : `${count} saved tasks still keep this deleted conversation's team, so they are deleted together.`} Its team
        workspaces, retention refs and exported patches are removed. Team branches go only when they are merged or pushed. Other branches and the run history stay.
      </p>
      {blocked ? (
        <p role="status" className="text-sm text-ink-3 mb-3">
          {blocked}
        </p>
      ) : null}
      {pending && !failure ? <p className="text-sm text-ink-3 mb-3">A delete request for this conversation is awaiting confirmation. Retry confirms its outcome without repeating cleanup.</p> : null}
      {error ? (
        <div role="alert" className="text-sm text-bad mb-3 break-words">
          {error}
        </div>
      ) : null}
      {deletion.recovery ? (
        <TeamRecoveryActions
          id={threadId}
          kind="delete"
          requestKey={deletion.recovery.requestKey}
          canKeepFiles
          retainedOwner
          onResolved={(state) => {
            close();
            if (state === "applied") onDeleted();
          }}
        />
      ) : null}
      <div className="flex justify-end gap-2 mt-3">
        <Button onClick={close}>{pending ? "Close" : "Cancel"}</Button>
        <Button variant="danger" disabled={busy || Boolean(blocked)} onClick={() => void run()}>
          {deleteButtonLabel({ working: remove.isPending, pending: Boolean(pending), count })}
        </Button>
      </div>
    </>
  );
}

function retainedDeleteBlockedReason(deletion: OwnerDeletion, savedError: string | null): string | null | undefined {
  if (!deletion.allowed) return deletion.reason;
  if (!deletion.recovery && savedError) return savedError;
  return null;
}
