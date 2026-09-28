import { useRef, useState } from "react";
import { useRpcMutation } from "../lib/query";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { finishTeamForkRequest, readTeamForkRequest } from "../lib/team-fork-request";
import { finishTeamRestoreRequest, readTeamRestoreRequest } from "../lib/team-restore-request";
import { finishTeamDeleteRequest, readTeamDeleteRequest } from "../lib/team-delete-request";
import { Button } from "./ui";

type Kind = "fork" | "restore" | "delete";
function clearRequest(id: string, kind: Kind, key: string): void {
  if (kind === "fork") {
    const saved = readTeamForkRequest(id);
    if (saved?.requestKey === key && !finishTeamForkRequest(id, saved)) throw new Error("Could not clear the saved fork request.");
  } else if (kind === "restore") {
    const saved = readTeamRestoreRequest(id);
    if (saved?.requestKey === key && !finishTeamRestoreRequest(id, saved)) throw new Error("Could not clear the saved restore request.");
  } else {
    const saved = readTeamDeleteRequest(id);
    if (saved?.requestKey === key && !finishTeamDeleteRequest(id, saved)) throw new Error("Could not clear the saved delete request.");
  }
}

/** Only retained server requests are cancellable; acknowledgement loss keeps the same key. */
export function TeamRecoveryActions({
  id,
  kind,
  requestKey,
  canKeepFiles = false,
  retainedOwner = false,
  onResolved,
}: {
  id: string;
  kind: Kind;
  requestKey: string;
  canKeepFiles?: boolean;
  retainedOwner?: boolean;
  onResolved?: (state: "cancelled" | "applied") => void;
}) {
  const cancel = useRpcMutation("threads.cancelTeamOperation");
  const busy = useThreadMutationPending(id);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (keepFiles?: boolean) => {
    if (busy || running.current) return;
    running.current = true;
    setError(null);
    try {
      const result = await cancel.mutateAsync({ id, kind, requestKey, ...(keepFiles === undefined ? {} : { keepFiles }) });
      clearRequest(id, kind, requestKey);
      onResolved?.(result.state);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      running.current = false;
    }
  };
  const subject = retainedOwner ? "saved tasks" : "conversation";
  return (
    <div className="space-y-2 text-sm">
      <p className="text-ink-3">
        {kind === "delete" ? `Cancel before cleanup starts to keep the ${subject} and files.` : "Cancel to keep the conversation and its files. Saved recovery copies are kept."}
      </p>
      <Button size="sm" disabled={busy} onClick={() => void resolve()}>
        Cancel {kind}
      </Button>
      {kind === "delete" && canKeepFiles ? (
        <>
          <p className="text-ink-3">If cleanup already started, you can remove the {subject} and keep every remaining folder and Git reference. Removed files cannot be restored by this action.</p>
          <Button size="sm" variant="danger" className="h-auto min-h-6 whitespace-normal text-left" disabled={busy} onClick={() => void resolve(true)}>
            Finish deletion, keep remaining files
          </Button>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-bad break-words">
          {error}
        </p>
      ) : null}
    </div>
  );
}
