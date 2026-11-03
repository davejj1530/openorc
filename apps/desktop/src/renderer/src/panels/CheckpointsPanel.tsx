import { relativeTime } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useState, type ReactNode } from "react";
import { History } from "../components/icons";
import { PanelBar, PanelBarMeta, PanelNotice } from "../components/PanelBar";
import { Button, Dialog, Empty } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { FileRows } from "./FileRows";

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
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedId = confirm;
  const items = [...(list.data ?? [])].reverse();
  const selected = items.find((item) => item.id === selectedId);
  const preview = useRpc("threads.restorePreview", { id: thread.id, checkpointId: confirm ?? "" }, { enabled: Boolean(confirm), staleTime: 0 });
  const previewBlocked = preview.data?.blocked ?? (preview.isError ? preview.error.message : null);
  const mutating = useThreadMutationPending(thread.id);
  const busy = mutating || restore.isPending;
  let blockedReason: string | null = null;
  if (thread.teamInstanceId) blockedReason = "This item is no longer available.";
  else if (thread.activity !== "idle") blockedReason = "Wait for the current turn to finish before restoring.";
  const select = (checkpointId: string) => {
    if (selectedId !== checkpointId) setError(null);
    setConfirm(checkpointId);
  };
  const submit = async () => {
    if (!selectedId || busy || blockedReason) return;
    setError(null);
    setNotice(null);
    try {
      await restore.mutateAsync({ id: thread.id, checkpointId: selectedId });
      setConfirm(null);
      setNotice("Checkpoint restored.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      void list.refetch();
    }
  };
  const status = blockedReason ? (
    <p role="status" className="text-sm text-ink-3">
      {blockedReason}
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
  let previewContent: ReactNode = null;
  if (confirm) {
    if (preview.isPending)
      previewContent = (
        <p role="status" className="text-sm text-ink-3 mb-3">
          Checking what will change…
        </p>
      );
    else if (preview.data?.files.length)
      previewContent = (
        <div className="mb-3 rounded-lg bg-surface-2 py-1">
          <FileRows files={preview.data.files} />
        </div>
      );
    else if (!previewBlocked) previewContent = <p className="text-sm text-ink-3 mb-3">The files already match this checkpoint.</p>;
  }
  let submitLabel = "Restore";
  if (restore.isPending) submitLabel = "Restoring…";
  return (
    <div className="h-full overflow-y-auto">
      <PanelBar title="Checkpoints" meta={items.length > 0 ? <PanelBarMeta>{items.length}</PanelBarMeta> : null} />
      {status ? <div className="px-5 pb-2.5">{status}</div> : null}

      {notice ? <PanelNotice>{notice}</PanelNotice> : null}
      {listStatus}
      <div className="panel-rows pb-2.5">
        {items.map((c, i) => {
          const stat = c.diffStat;
          return (
            <div key={c.id} className="flex items-center gap-3 mx-2.5 px-2.5 py-2.5 text-base">
              <History size={14} className={cn("shrink-0", i === 0 ? "text-ink-2" : "text-ink-4")} />
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  {c.note ?? `Turn ${c.turn}`}
                  {i === 0 ? " (latest)" : ""}
                </div>
                <div className="flex items-center gap-2 text-sm text-ink-3">
                  <span className="font-mono tabular">
                    {stat.files + stat.untracked} file{stat.files + stat.untracked === 1 ? "" : "s"} <span className="text-ok">+{stat.insertions}</span>{" "}
                    <span className="text-bad">-{stat.deletions}</span>
                  </span>
                  <span className="ml-auto tabular text-ink-4">{relativeTime(c.createdAt)}</span>
                </div>
              </div>
              <Button disabled={Boolean(blockedReason) || busy} title={blockedReason ?? undefined} onClick={() => select(c.id)}>
                {"Restore"}
              </Button>
            </div>
          );
        })}
      </div>
      {error && !confirm ? (
        <PanelNotice role="alert" tone="bad">
          {error}
        </PanelNotice>
      ) : null}
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
        title={"Restore this checkpoint?"}
      >
        {selectedSummary}
        <p className="text-base text-ink-2 mb-4">
          {
            "The files go back to how they were at that checkpoint: changes made since are undone, and files created since are deleted. Staged changes stay staged. The files as they are now are saved as a checkpoint first, so you can restore them again. Tell the agent what you did next."
          }
        </p>
        {previewContent}
        {previewBlocked ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {previewBlocked}
          </p>
        ) : null}
        {status ? <div className="mb-3">{status}</div> : null}
        {error ? (
          <p role="alert" className="text-sm text-bad mb-3 break-words">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button disabled={busy} onClick={() => setConfirm(null)}>
            {"Cancel"}
          </Button>
          <Button variant="danger" disabled={Boolean(blockedReason) || Boolean(previewBlocked) || busy || !selectedId} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
