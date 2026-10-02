import { threadForkLabel, threadMoveLabel, threadDeletionDescription, threadDeleteBlockedReason, deleteButtonLabel } from "../lib/team-action-presentation";
import { WORKSPACE_ID } from "@openorc/protocol";
import { useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { ThreadSummary } from "@openorc/protocol";
import { AlarmClock, AppWindow, Archive, ArchiveRestore, Columns2, GitBranch, GitFork, Laptop, MailOpen, Pencil, Pin, PinOff, Trash2 } from "./icons";
import { orclingHome, useOrclings } from "../lib/orclings";
import { Button, Dialog } from "./ui";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { hasOpenTeamExecution } from "../lib/team-activity";
import { MAX_THREAD_PANES, openThread, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { useTeamFork } from "../lib/use-team-fork";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useTeamMoveRequest } from "../lib/use-team-move-request";
import { pendingTeamMove } from "../lib/team-move-request";
import { teamDeleteReason, teamLifecycleReason, teamMoveReason } from "../lib/thread-action-reasons";
import { useTeamDeleteRequest } from "../lib/use-team-delete-request";
import { beginTeamDeleteRequest, finishTeamDeleteRequest } from "../lib/team-delete-request";
import { CoversPreview } from "../lib/browser-preview";
import { TeamRecoveryActions } from "./TeamRecoveryActions";

/** The parts a dropdown and a context menu share, so one item list serves both. */
export type MenuParts = Pick<typeof Menu, "Item" | "Separator" | "SubmenuRoot" | "SubmenuTrigger" | "Portal" | "Positioner" | "Popup">;

export const menuItem =
  "flex items-center gap-2 h-7 px-2 rounded-md text-base text-ink-2 cursor-pointer data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[disabled]:opacity-50 data-[disabled]:cursor-default outline-none";
export const menuPopup = "menu-popup min-w-48 rounded-lg border border-line bg-surface p-1 shadow-panel outline-none";

/** When a snoozed thread comes back, from now. */
export function snoozePresets(now = new Date()): { label: string; until: number }[] {
  const at = (h: number, m = 0, addDays = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + addDays);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const evening = at(18);
  const nextMonday = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  })();
  return [
    { label: "In 1 hour", until: now.getTime() + 3_600_000 },
    { label: "In 3 hours", until: now.getTime() + 3 * 3_600_000 },
    ...(evening > now.getTime() + 600_000 ? [{ label: "This evening", until: evening }] : []),
    { label: "Tomorrow morning", until: at(9, 0, 1) },
    { label: "Next week", until: nextMonday },
  ];
}

/** Every action a thread has, as menu items. The same list serves the header menu and the sidebar's context menu. */
export function ThreadMenuItems({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const home = orclingHome(useOrclings(), thread.id);
  // An Orcling's own conversation lives and goes with the Orcling, which you change in its designer.
  if (home) {
    return (
      <M.Item className={menuItem} onClick={() => useRouter.getState().navigate({ view: "orcling", orclingId: home.id })}>
        <Pencil size={13} /> Edit {home.name}
      </M.Item>
    );
  }
  return <ThreadMenuContent key={thread.id} thread={thread} parts={M} />;
}

function ThreadMenuContent({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const update = useRpcMutation("threads.update");
  const addPane = useRouter((s) => s.addThreadPane);
  const cannotSplit = useRouter((s) => s.threadIds.includes(thread.id) || s.threadIds.length >= MAX_THREAD_PANES);
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) => update.mutate({ id: thread.id, patch: p });
  const archived = Boolean(thread.archivedAt);
  const busy = thread.activity !== "idle";
  const team = Boolean(thread.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: thread.id }, { enabled: team });
  const teamFork = useTeamFork(thread.id, team);
  const savedMove = useTeamMoveRequest(thread.id, team);
  const moveRecovery = runtime.data?.actions?.moveRecovery;
  const pendingMove = pendingTeamMove(savedMove.request, moveRecovery);
  const moveReason = teamMoveReason({
    team,
    loadFailed: runtime.isError,
    loaded: Boolean(runtime.data),
    availability: runtime.data?.actions?.move,
    hasRecovery: Boolean(moveRecovery),
    savedError: savedMove.error,
    hasPendingRequest: Boolean(pendingMove),
  });
  const moveNeedsRefresh = team && (runtime.isError || !runtime.data?.actions?.move || Boolean(savedMove.error));
  const savedDelete = useTeamDeleteRequest(thread.id, team);
  const deleteRecovery = runtime.data?.actions?.deleteRecovery;
  const deleteReason = teamDeleteReason({
    team,
    loadFailed: runtime.isError,
    loaded: Boolean(runtime.data),
    availability: runtime.data?.actions?.delete,
    hasRecovery: Boolean(deleteRecovery),
    savedError: savedDelete.error,
    hasPendingRequest: Boolean(savedDelete.request),
  });
  const deleteNeedsRefresh = team && (runtime.isError || !runtime.data?.actions?.delete || Boolean(savedDelete.error));
  const pendingDelete = deleteRecovery ?? savedDelete.request;
  // Mutations can outlive a closed menu. Reopening it must not enable sibling writes.
  const mutating = useThreadMutationPending(thread.id);
  const lifecycleReason = teamLifecycleReason({
    team,
    loadFailed: runtime.isError,
    loaded: Boolean(runtime.data),
    hasOpenExecution: Boolean(runtime.data && hasOpenTeamExecution(runtime.data.executions)),
    hasPendingPublication: Boolean(runtime.data?.executions.some((execution) => execution.publications.some((publication) => publication.state !== "applied"))),
  });
  const lifecycleBlocked = Boolean(lifecycleReason) || (team && mutating);
  const actionError = update.error;

  return (
    <>
      <M.Item className={menuItem} disabled={cannotSplit} onClick={() => addPane(thread.id)}>
        <Columns2 size={13} /> Open beside
      </M.Item>
      <M.Item className={menuItem} onClick={() => window.openorc.openWindow(`thread:${thread.id}`)}>
        <AppWindow size={13} /> Open in new window
      </M.Item>
      <M.Separator className="my-1 h-px bg-line" />
      {lifecycleReason ? (
        <div className="max-w-64 px-2 py-1 text-xs text-ink-3" role="status">
          {lifecycleReason}
        </div>
      ) : null}
      {team && (teamFork.needsRefresh || moveNeedsRefresh || deleteNeedsRefresh) ? (
        <M.Item
          className={menuItem}
          disabled={mutating || teamFork.refreshing}
          closeOnClick={false}
          onClick={() => {
            teamFork.refresh();
            savedMove.refresh();
            savedDelete.refresh();
          }}
        >
          Refresh team status
        </M.Item>
      ) : null}
      {teamFork.failure || actionError ? (
        <div className="max-w-64 px-2 py-1 text-xs text-bad break-words" role="alert">
          {teamFork.failure?.message ?? actionError?.message}
        </div>
      ) : null}
      <M.Item className={menuItem} disabled={team && mutating} onClick={() => patch({ pinned: !thread.pinnedAt })}>
        {thread.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />} {thread.pinnedAt ? "Unpin" : "Pin"}
      </M.Item>
      <M.SubmenuRoot>
        <M.SubmenuTrigger className={menuItem} disabled={lifecycleBlocked} title={lifecycleReason ?? undefined}>
          <AlarmClock size={13} /> {thread.snoozedUntil ? "Snoozed" : "Snooze"}
          <span className="ml-auto text-ink-4">›</span>
        </M.SubmenuTrigger>
        <M.Portal>
          <CoversPreview />
          <M.Positioner sideOffset={4} alignOffset={-4} collisionPadding={8}>
            <M.Popup className={menuPopup}>
              {snoozePresets().map((p) => (
                <M.Item key={p.label} className={menuItem} disabled={lifecycleBlocked} closeOnClick={!team} onClick={() => patch({ snoozedUntil: p.until })}>
                  {p.label}
                </M.Item>
              ))}
              {thread.snoozedUntil ? (
                <>
                  <M.Separator className="my-1 h-px bg-line" />
                  <M.Item className={menuItem} disabled={lifecycleBlocked} closeOnClick={!team} onClick={() => patch({ snoozedUntil: null })}>
                    Wake now
                  </M.Item>
                </>
              ) : null}
            </M.Popup>
          </M.Positioner>
        </M.Portal>
      </M.SubmenuRoot>
      <M.Item className={menuItem} disabled={team && mutating} onClick={() => patch({ seen: thread.unread })}>
        <MailOpen size={13} /> {thread.unread ? "Mark as read" : "Mark as unread"}
      </M.Item>
      <M.Separator className="my-1 h-px bg-line" />
      <ThreadForkActions thread={thread} parts={M} teamFork={teamFork} recoveryKey={runtime.data?.actions?.forkRecovery?.requestKey} />
      {team && moveReason ? (
        <div role="status" className="max-w-64 px-2 py-1 text-xs text-ink-3 break-words">
          {moveReason}
        </div>
      ) : null}
      {thread.projectId !== WORKSPACE_ID ? (
        <M.Item
          className={menuItem}
          disabled={team ? Boolean(moveReason) || mutating : busy}
          title={moveReason ?? undefined}
          onClick={() => (team ? useUi.getState().setTeamMoveThread(thread.id) : useUi.getState().setMoveThread(thread.id))}
        >
          {(pendingMove?.to ?? (thread.workspaceMode === "worktree" ? "current" : "worktree")) === "current" ? <Laptop size={13} /> : <GitBranch size={13} />}{" "}
          {threadMoveLabel({ cancelling: pendingMove?.phase === "cancel", pending: Boolean(pendingMove), mode: thread.workspaceMode })}
        </M.Item>
      ) : null}
      <M.Separator className="my-1 h-px bg-line" />
      <M.Item className={menuItem} disabled={lifecycleBlocked} title={lifecycleReason ?? undefined} closeOnClick={!team} onClick={() => patch({ archived: !archived })}>
        {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />} {archived ? "Unarchive" : "Archive"}
      </M.Item>
      {team && deleteReason ? (
        <div role="status" className="max-w-64 px-2 py-1 text-xs text-ink-3 break-words">
          {deleteReason}
        </div>
      ) : null}
      <M.Item
        className={cn(menuItem, "text-bad data-[highlighted]:text-bad")}
        disabled={team && (Boolean(deleteReason) || mutating)}
        title={deleteReason ?? undefined}
        onClick={() => useUi.getState().setDeleteThread(thread.id)}
      >
        <Trash2 size={13} /> {pendingDelete ? "Retry delete" : "Delete thread"}
      </M.Item>
    </>
  );
}

function ThreadForkActions({ thread, parts: M, teamFork, recoveryKey }: { thread: ThreadSummary; parts: MenuParts; teamFork: ReturnType<typeof useTeamFork>; recoveryKey?: string }) {
  const team = Boolean(thread.teamInstanceId);
  const fork = useRpcMutation("threads.fork");
  const mutating = useThreadMutationPending(thread.id);
  const [recovering, setRecovering] = useState<string | null>(null);
  return (
    <>
      {fork.error ? (
        <p role="alert" className="max-w-64 px-2 py-1 text-xs text-bad break-words">
          {fork.error.message}
        </p>
      ) : null}
      {team && (teamFork.reason || teamFork.recoveryError) ? (
        <div role="status" className="max-w-64 px-2 py-1 text-xs text-ink-3 break-words">
          {teamFork.reason ?? teamFork.recoveryError}
        </div>
      ) : null}
      <M.Item
        className={menuItem}
        disabled={team ? Boolean(teamFork.reason) || mutating : fork.isPending}
        closeOnClick={!team}
        title={teamFork.reason ?? (team ? "Create an independent task with this team and conversation history." : undefined)}
        onClick={() =>
          team
            ? void teamFork.run()
            : fork.mutate(
                { id: thread.id },
                {
                  onSuccess: (t) => {
                    if (!("rejected" in t)) openThread(t.id);
                  },
                },
              )
        }
      >
        <GitFork size={13} /> {threadForkLabel({ working: fork.isPending || teamFork.working, retry: Boolean(team && teamFork.pending) })}
      </M.Item>
      {recoveryKey ? (
        <M.Item className={menuItem} closeOnClick={false} disabled={mutating} onClick={() => setRecovering(recoveryKey)}>
          Cancel pending fork…
        </M.Item>
      ) : null}
      <Dialog
        open={Boolean(recovering)}
        onOpenChange={(open) => {
          if (!open) setRecovering(null);
        }}
        title="Cancel pending fork?"
      >
        {recovering ? (
          <TeamRecoveryActions
            id={thread.id}
            kind="fork"
            requestKey={recovering}
            onResolved={() => {
              setRecovering(null);
              teamFork.refresh();
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

/** One confirm for every delete entry point. Tasks the thread created stay. */
export function DeleteThreadDialog() {
  const id = useUi((s) => s.deleteThreadId);
  const close = () => useUi.getState().setDeleteThread(null);
  return (
    <Dialog open={Boolean(id)} onOpenChange={(open) => (open ? undefined : close())} title="Delete this thread?">
      {id ? <DeleteThreadContent key={id} id={id} close={close} /> : null}
    </Dialog>
  );
}

function DeleteThreadContent({ id, close }: { id: string; close: () => void }) {
  const thread = useRpc("threads.get", { id });
  const team = Boolean(thread.data?.teamInstanceId);
  const runtime = useRpc("orchestration.runtime", { threadId: id }, { enabled: team });
  const saved = useTeamDeleteRequest(id, team);
  const remove = useRpcMutation("threads.delete");
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const recovery = runtime.data?.actions?.deleteRecovery;
  const pending = recovery ?? saved.request;
  const tasks = thread.data?.taskCount ?? 0;
  const copy = threadDeletionDescription({ team, tasks });
  const blocked = threadDeleteBlockedReason({ loading: thread.isPending, exists: Boolean(thread.data), teamLoading: team && runtime.isPending, savedError: team && !recovery ? saved.error : null });
  // A team delete carries one durable key: a lost reply is retried with the
  // same key, a rejection is final, and only a definite outcome clears it.
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      const request = team ? beginTeamDeleteRequest(id, recovery) : null;
      const result = await remove.mutateAsync({ id, ...(request ? { requestKey: request.requestKey } : {}) });
      if (result && "rejected" in result) {
        if (request) finishTeamDeleteRequest(id, request);
        setFailure(result.rejected || "This delete request was rejected.");
        return;
      }
      if (request) finishTeamDeleteRequest(id, request);
      close();
      useRouter.getState().closeThreadPane(id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  };
  const error = failure ?? recovery?.error ?? null;
  return (
    <>
      <p className="text-base text-ink-2 mb-4">{copy}</p>
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
      {recovery ? (
        <div className="mb-4">
          <TeamRecoveryActions
            id={id}
            kind="delete"
            requestKey={recovery.requestKey}
            canKeepFiles={tasks === 0}
            onResolved={(state) => {
              close();
              if (state === "applied") useRouter.getState().closeThreadPane(id);
            }}
          />
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button onClick={close}>{pending ? "Close" : "Cancel"}</Button>
        <Button variant="danger" disabled={remove.isPending || Boolean(blocked)} onClick={() => void run()}>
          {deleteButtonLabel({ working: remove.isPending, pending: Boolean(pending) })}
        </Button>
      </div>
    </>
  );
}
