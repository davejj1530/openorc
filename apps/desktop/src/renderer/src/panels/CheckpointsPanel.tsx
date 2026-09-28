import { useEffect, useState, type ReactNode } from "react";
import type { ThreadSummary } from "@openorc/protocol";
import { History } from "../components/icons";
import { Button, Dialog, Empty, TextButton } from "../components/ui";
import { FileRows } from "./FileRows";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { relativeTime } from "../lib/time";
import { beginTeamRestoreRequest, finishTeamRestoreRequest, readTeamRestoreRequest, teamRestoreStorageKey, type TeamRestoreRequest } from "../lib/team-restore-request";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { TeamRecoveryActions } from "../components/TeamRecoveryActions";

function checkpointListStatus(input: { error: Error | null; loading: boolean; empty: boolean; retry: () => void }): ReactNode {
  if (input.error) {
    return (
      <Empty title="Could not load checkpoints">
        {input.error.message}
        <Button size="sm" className="mt-3" onClick={input.retry}>
          Retry
        </Button>
      </Empty>
    );
  }
  if (!input.loading && input.empty) return <Empty title="No checkpoints yet">Every finished turn leaves one. Restore any of them to put the files back.</Empty>;
  return null;
}

/**
 * Existing turns remain readable. Team restores switch to a retained copy;
 * ordinary restores keep their established in-place behavior.
 */
export function CheckpointsPanel({ thread }: { thread: ThreadSummary }) {
  const list = useRpc("threads.checkpoints", { id: thread.id });
  const restore = useRpcMutation("threads.restore");
  const team = Boolean(thread.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: thread.id }, { enabled: team });
  const readRequest = (): { request: TeamRestoreRequest | null; error: string | null } => {
    if (!team) return { request: null, error: null };
    try {
      return { request: readTeamRestoreRequest(thread.id), error: null };
    } catch (error) {
      return { request: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const [saved, setSaved] = useState(readRequest);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recovery = runtime.data?.actions?.restoreRecovery;
  const pending = recovery ?? saved.request;
  const selectedId = pending?.checkpointId ?? confirm;
  const items = [...(list.data ?? [])].reverse();
  const selected = items.find((item) => item.id === selectedId);
  const preview = useRpc("threads.restorePreview", { id: thread.id, checkpointId: confirm ?? "" }, { enabled: !team && Boolean(confirm), staleTime: 0 });
  const previewBlocked = !team ? (preview.data?.blocked ?? (preview.isError ? preview.error.message : null)) : null;
  const mutating = useThreadMutationPending(thread.id);
  const busy = team ? mutating : restore.isPending;
  let blockedReason: string | null = null;
  if (!team) {
    if (thread.activity !== "idle") blockedReason = "Wait for the current turn to finish before restoring.";
  } else if (runtime.isError) blockedReason = "Could not check team restore availability. Refresh team status to retry.";
  else if (runtime.isPending || !runtime.data) blockedReason = "Checking team restore availability…";
  else if (!runtime.data.actions?.restore) blockedReason = "Team restore availability is missing. Refresh team status to retry.";
  else if (!recovery && saved.error) blockedReason = saved.error;
  else if (!pending && !runtime.data.actions.restore.allowed) blockedReason = runtime.data.actions.restore.reason ?? "Restore is currently unavailable for this team.";
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key === teamRestoreStorageKey(thread.id)) setSaved(readRequest());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [thread.id, team]);
  const refresh = () => {
    setSaved(readRequest());
    void list.refetch();
    if (team) void runtime.refetch();
  };
  const select = (checkpointId: string) => {
    if (selectedId !== checkpointId) setError(null);
    setConfirm(checkpointId);
  };
  const submit = async () => {
    if (!selectedId || busy || blockedReason) return;
    setError(null);
    setNotice(null);
    try {
      const request = team ? beginTeamRestoreRequest(thread.id, selectedId, recovery) : null;
      if (request) setSaved({ request, error: null });
      const result = await restore.mutateAsync({ id: thread.id, checkpointId: request?.checkpointId ?? selectedId, ...(request ? { requestKey: request.requestKey } : {}) });
      if (result) {
        const reason = result.rejected || "The restore request was rejected.";
        const cleared = !request || finishTeamRestoreRequest(thread.id, request);
        setSaved(readRequest());
        setError(cleared ? reason : `${reason} The request was rejected, but its local recovery record could not be cleared. Retry the saved request to confirm that rejection.`);
        return;
      }
      if (request && !finishTeamRestoreRequest(thread.id, request))
        throw new Error("The workspace was restored, but its local recovery record could not be cleared. Retry the saved request to confirm the same restore.");
      setSaved(readRequest());
      setConfirm(null);
      setNotice(team ? "Checkpoint restored into a new team workspace. The previous workspace is kept." : "Checkpoint restored.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      void list.refetch();
      if (team) void runtime.refetch();
    }
  };
  const status = blockedReason ? (
    <p role="status" className="text-sm text-ink-3">
      {blockedReason}
      {team ? (
        <>
          {" "}
          <TextButton type="button" disabled={busy || runtime.isFetching} underline onClick={refresh}>
            Refresh team status
          </TextButton>
        </>
      ) : null}
    </p>
  ) : null;
  const listStatus = checkpointListStatus({ error: list.error, loading: list.isLoading, empty: items.length === 0, retry: () => void list.refetch() });
  let selectedSummary: ReactNode = null;
  if (selected)
    selectedSummary = (
      <p className="text-sm text-ink-3 mb-3">
        {selected.note ?? `Turn ${selected.turn}`} · {new Date(selected.createdAt).toLocaleString()}
      </p>
    );
  else if (pending) selectedSummary = <p className="text-sm text-ink-3 mb-3">The saved checkpoint is retained with this request.</p>;
  let previewContent: ReactNode = null;
  if (!team && confirm) {
    if (preview.isPending)
      previewContent = (
        <p role="status" className="text-sm text-ink-3 mb-3">
          Checking what will change…
        </p>
      );
    else if (preview.data?.files.length)
      previewContent = (
        <div className="mb-3 rounded-md border border-line">
          <FileRows files={preview.data.files} />
        </div>
      );
    else if (!previewBlocked) previewContent = <p className="text-sm text-ink-3 mb-3">The files already match this checkpoint.</p>;
  }
  let submitLabel = "Restore";
  if (restore.isPending) submitLabel = "Restoring…";
  else if (pending) submitLabel = "Retry restore";
  return (
    <div className="h-full overflow-y-auto">
      {status ? <div className="px-3 py-2 border-b border-line">{status}</div> : null}
      <PendingTeamRestore
        id={thread.id}
        pending={pending}
        recovery={recovery}
        busy={busy}
        select={select}
        resolved={() => {
          setConfirm(null);
          setError(null);
          setNotice("Restore request resolved. Saved files were kept.");
          refresh();
        }}
      />
      {notice ? (
        <p role="status" className="px-3 py-2 text-sm text-ink-3">
          {notice}
        </p>
      ) : null}
      {listStatus}
      {items.map((c, i) => {
        const stat = c.diffStat;
        return (
          <div key={c.id} className="flex items-center gap-3 px-3 py-2 border-b border-line text-base">
            <History size={14} className={cn("shrink-0", i === 0 ? "text-ink-2" : "text-ink-4")} />
            <div className="flex-1 min-w-0">
              <div className="truncate">
                {c.note ?? `Turn ${c.turn}`}
                {i === 0 ? " (latest)" : ""}
              </div>
              <div className="flex items-center gap-2 text-sm text-ink-3">
                <span className="font-mono text-xs tabular">
                  {stat.files + stat.untracked} file{stat.files + stat.untracked === 1 ? "" : "s"} <span className="text-ok">+{stat.insertions}</span>{" "}
                  <span className="text-bad">-{stat.deletions}</span>
                </span>
                <span className="ml-auto tabular text-ink-4">{relativeTime(c.createdAt)}</span>
              </div>
            </div>
            <Button
              size="sm"
              disabled={Boolean(blockedReason) || busy || Boolean(pending && pending.checkpointId !== c.id)}
              title={pending && pending.checkpointId !== c.id ? "Confirm the saved restore request before choosing another checkpoint." : (blockedReason ?? undefined)}
              onClick={() => select(c.id)}
            >
              {pending?.checkpointId === c.id ? "Retry restore" : "Restore"}
            </Button>
          </div>
        );
      })}
      {error && !confirm ? (
        <p role="alert" className="px-3 py-2 text-sm text-bad break-words">
          {error}
        </p>
      ) : null}
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        title={pending ? "Confirm the saved restore" : "Restore this checkpoint?"}
      >
        {selectedSummary}
        <p className="text-base text-ink-2 mb-4">
          {team
            ? "Restore the selected checkpoint into a new team workspace. The current workspace and conversation are kept. No agent starts until you send another message."
            : "The files go back to how they were at that checkpoint: changes made since are undone, and files created since are deleted. Staged changes stay staged. The files as they are now are saved as a checkpoint first, so you can restore them again. Tell the agent what you did next."}
        </p>
        {previewContent}
        {previewBlocked ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {previewBlocked}
          </p>
        ) : null}
        {status ? <div className="mb-3">{status}</div> : null}
        {error || recovery?.error ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {error ?? recovery?.error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={() => setConfirm(null)}>
            {pending ? "Close" : "Cancel"}
          </Button>
          <Button variant={team ? "primary" : "danger"} disabled={Boolean(blockedReason) || Boolean(previewBlocked) || busy || !selectedId} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function PendingTeamRestore({
  id,
  pending,
  recovery,
  busy,
  select,
  resolved,
}: {
  id: string;
  pending: TeamRestoreRequest | null | undefined;
  recovery: { requestKey: string; checkpointId: string; error: string | null } | undefined;
  busy: boolean;
  select: (checkpointId: string) => void;
  resolved: () => void;
}) {
  if (!pending) return null;
  return (
    <div className="px-3 py-2 border-b border-line space-y-2" data-team-restore-request={pending.requestKey}>
      <p className="text-sm text-ink-3">A saved restore request is awaiting confirmation. It keeps the same checkpoint and workspace change.</p>
      <Button size="sm" disabled={busy} onClick={() => select(pending.checkpointId)}>
        Retry restore
      </Button>
      {recovery ? <TeamRecoveryActions id={id} kind="restore" requestKey={recovery.requestKey} onResolved={resolved} /> : null}
      {recovery?.error ? (
        <p role="alert" className="text-sm text-bad break-words">
          {recovery.error}
        </p>
      ) : null}
    </div>
  );
}
