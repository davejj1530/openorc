import { Menu } from "@base-ui/react/menu";
import { canMoveToCloud, cloudServiceMissing, offersBrainMove, snoozePresets, threadResolved } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { WORKSPACE_ID, isSubagentThread } from "@openorc/protocol";
import { useRef, useState } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { orclingHome, useOrclings } from "../lib/orclings";
import { MAX_THREAD_PANES, newSubthread, openThread, useRouter } from "../lib/router";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { AlarmClock, AppWindow, ChevronRight, CircleCheck, Cloud, Columns2, Folder, GitBranch, GitFork, Laptop, MailOpen, PenSquare, Pencil, Pin, PinOff, RotateCcw, Trash2 } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { Button, Dialog } from "./ui";

/** The parts a dropdown and a context menu share, so one item list serves both. */
export type MenuParts = Pick<typeof Menu, "Item" | "Separator" | "SubmenuRoot" | "SubmenuTrigger" | "Portal" | "Positioner" | "Popup">;

/** Every action a thread has, as menu items. The same list serves the header menu and the sidebar's context menu. */
export function ThreadMenuItems({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const home = orclingHome(useOrclings(), thread.id);
  if (isSubagentThread(thread))
    return (
      <>
        <M.Item className={menuItem} onClick={() => useRouter.getState().addThreadPane(thread.id)}>
          <Columns2 size={13} /> Open beside
        </M.Item>
        <M.Item className={menuItem} onClick={() => window.openorc.openWindow(`thread:${thread.id}`)}>
          <AppWindow size={13} /> Open in new window
        </M.Item>
        <OpenParentItem thread={thread} parts={M} />
        {thread.subagent?.status !== "running" && thread.activity === "idle" ? (
          <M.Item className={menuItemDanger} onClick={() => useUi.getState().setDeleteThread(thread.id)}>
            <Trash2 size={13} /> Delete thread
          </M.Item>
        ) : null}
      </>
    );
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

function OpenParentItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const parent = thread.parentThreadId;
  return parent ? (
    <M.Item className={menuItem} onClick={() => openThread(parent)}>
      Open parent
    </M.Item>
  ) : null;
}

function ThreadMenuContent({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const update = useRpcMutation("threads.update");
  const addPane = useRouter((s) => s.addThreadPane);
  const cannotSplit = useRouter((s) => s.threadIds.includes(thread.id) || s.threadIds.length >= MAX_THREAD_PANES);
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) => update.mutate({ id: thread.id, patch: p });
  const resolved = threadResolved(thread, Date.now());
  const busy = thread.activity !== "idle";
  const team = Boolean(thread.teamInstanceId);
  // Mutations can outlive a closed menu. Reopening it must not enable sibling writes.
  const mutating = useThreadMutationPending(thread.id);
  const lifecycleBlocked = mutating;
  const moveReason = team ? "This item is no longer available." : null;
  const deleteReason = moveReason;
  const actionError = update.error;
  const inCloud = thread.owner?.brain === "cloud";

  return (
    <>
      <M.Item className={menuItem} disabled={cannotSplit} onClick={() => addPane(thread.id)}>
        <Columns2 size={13} /> Open beside
      </M.Item>
      <M.Item className={menuItem} onClick={() => window.openorc.openWindow(`thread:${thread.id}`)}>
        <AppWindow size={13} /> Open in new window
      </M.Item>
      <OpenParentItem thread={thread} parts={M} />
      <M.Separator className={menuSeparator} />

      {actionError ? (
        <div className="max-w-64 px-2 py-1 text-xs text-bad break-words" role="alert">
          {actionError?.message}
        </div>
      ) : null}
      <M.Item className={menuItem} disabled={mutating} onClick={() => patch({ pinned: !thread.pinnedAt })}>
        {thread.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />} {thread.pinnedAt ? "Unpin" : "Pin"}
      </M.Item>
      <M.SubmenuRoot>
        <M.SubmenuTrigger className={menuItem} disabled={lifecycleBlocked}>
          <AlarmClock size={13} /> {thread.snoozedUntil ? "Snoozed" : "Snooze"}
          <ChevronRight size={14} className="ml-auto" />
        </M.SubmenuTrigger>
        <M.Portal>
          <CoversPreview />
          <M.Positioner sideOffset={4} alignOffset={-6} collisionPadding={8}>
            <M.Popup ref={floatingGround} className={menuPopup}>
              {snoozePresets().map((p) => (
                <M.Item key={p.label} className={menuItem} disabled={lifecycleBlocked} closeOnClick onClick={() => patch({ snoozedUntil: p.until(new Date()) })}>
                  {p.label}
                </M.Item>
              ))}
              {thread.snoozedUntil ? (
                <>
                  <M.Separator className={menuSeparator} />
                  <M.Item className={menuItem} disabled={lifecycleBlocked} closeOnClick onClick={() => patch({ snoozedUntil: null })}>
                    Wake now
                  </M.Item>
                </>
              ) : null}
            </M.Popup>
          </M.Positioner>
        </M.Portal>
      </M.SubmenuRoot>
      <M.Item className={menuItem} disabled={mutating} onClick={() => patch({ seen: thread.unread })}>
        <MailOpen size={13} /> {thread.unread ? "Mark as read" : "Mark as unread"}
      </M.Item>
      <M.Separator className={menuSeparator} />
      <ThreadForkActions thread={thread} parts={M} />

      {thread.projectId !== WORKSPACE_ID && !inCloud ? (
        <M.Item className={menuItem} disabled={team ? Boolean(moveReason) || mutating : busy} title={moveReason ?? undefined} onClick={() => useUi.getState().setMoveThread(thread.id)}>
          {thread.workspaceMode === "worktree" ? <Laptop size={13} /> : <GitBranch size={13} />} {thread.workspaceMode === "worktree" ? "Move to the checkout" : "Move to a worktree"}
        </M.Item>
      ) : null}
      <CloudMoveItems thread={thread} parts={M} />
      <M.Separator className={menuSeparator} />
      <M.Item className={menuItem} disabled={lifecycleBlocked} closeOnClick onClick={() => patch({ archived: !resolved })}>
        {resolved ? <RotateCcw size={13} /> : <CircleCheck size={13} />} {resolved ? "Reopen" : "Resolve"}
      </M.Item>

      <M.Item className={menuItemDanger} disabled={team || mutating} title={deleteReason ?? undefined} onClick={() => useUi.getState().setDeleteThread(thread.id)}>
        <Trash2 size={13} /> {"Delete thread"}
      </M.Item>
    </>
  );
}

/** Where the conversation lives: Move to cloud, Bring to Mac, or Keep where it is while it moves. */
function CloudMoveItems({ thread, parts }: { thread: ThreadSummary; parts: MenuParts }) {
  if (thread.moving) return <KeepItem thread={thread} parts={parts} to={thread.moving.to} />;
  if (thread.owner?.brain === "cloud") return <CloudThreadItems thread={thread} parts={parts} />;
  return <MoveToCloudItem thread={thread} parts={parts} />;
}

function MenuError({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="max-w-64 px-2 py-1 text-xs text-bad break-words">
      {error.message}
    </p>
  ) : null;
}

function KeepItem({ thread, parts: M, to }: { thread: ThreadSummary; parts: MenuParts; to: "mac" | "cloud" }) {
  const keep = useRpcMutation("cloud.keep");
  return (
    <>
      <MenuError error={keep.error} />
      <M.Item className={menuItem} disabled={keep.isPending} onClick={() => keep.mutate({ threadId: thread.id })}>
        {to === "cloud" ? <Laptop size={13} /> : <Cloud size={13} />} {to === "cloud" ? "Keep on this Mac" : "Keep in the cloud"}
      </M.Item>
    </>
  );
}

function CloudThreadItems({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const bring = useRpcMutation("cloud.bringToMac");
  const openCopy = useRpcMutation("cloud.openOnMac");
  const closeCopy = useRpcMutation("cloud.closeOnMac");
  const mirrored = Boolean(thread.owner?.mirror);
  return (
    <>
      <MenuError error={bring.error ?? openCopy.error ?? closeCopy.error} />
      <M.Item className={menuItem} disabled={thread.activity !== "idle" || bring.isPending} onClick={() => bring.mutate({ threadId: thread.id })}>
        <Laptop size={13} /> Bring to Mac
      </M.Item>
      <M.Item className={menuItem} disabled={openCopy.isPending || closeCopy.isPending} onClick={() => (mirrored ? closeCopy : openCopy).mutate({ threadId: thread.id })}>
        <Folder size={13} /> {mirrored ? "Close on Mac" : "Open on Mac"}
      </M.Item>
    </>
  );
}

/** With a cloud brain, the move is the brain's and may be refused with its reason; without one, today's sandbox move. */
function MoveToCloudItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const offer = useRpc("cloud.offer", {}).data;
  const brain = Boolean(offer?.brain);
  if (!(brain ? offersBrainMove(thread) : canMoveToCloud(thread))) return null;
  const missing = cloudServiceMissing(offer);
  return (
    <M.Item className={menuItem} disabled={thread.activity !== "idle" || Boolean(missing)} title={missing ?? undefined} onClick={() => useUi.getState().setMoveThread(thread.id, "cloud")}>
      <Cloud size={13} /> Move to cloud
    </M.Item>
  );
}

function ThreadForkActions({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const fork = useRpcMutation("threads.fork");
  const mutating = useThreadMutationPending(thread.id);
  const inCloud = thread.owner?.brain === "cloud";
  return (
    <>
      {fork.error ? (
        <p role="alert" className="max-w-64 px-2 py-1 text-xs text-bad break-words">
          {fork.error.message}
        </p>
      ) : null}
      <M.Item className={menuItem} disabled={Boolean(thread.teamInstanceId) || inCloud} title={inCloud ? "Bring it to this Mac first." : undefined} onClick={() => newSubthread(thread.id)}>
        <PenSquare size={13} /> New subthread
      </M.Item>
      <M.Item
        className={menuItem}
        disabled={Boolean(thread.teamInstanceId) || inCloud || mutating || fork.isPending}
        title={inCloud ? "Bring it to this Mac first." : undefined}
        onClick={() => fork.mutate({ id: thread.id }, { onSuccess: (t) => openThread(t.id) })}
      >
        <GitFork size={13} /> {fork.isPending ? "Forking…" : "Fork"}
      </M.Item>
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
  const remove = useRpcMutation("threads.delete");
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const copy = isSubagentThread(thread.data)
    ? "This saved conversation and its nested subagents are removed. The parent conversation and shared files stay."
    : "The conversation is removed, and its worktree with it. Tasks it created stay, with their worktrees and branches.";
  let blocked: string | null = null;
  if (thread.isPending) blocked = "Checking this thread…";
  else if (!thread.data) blocked = "This thread no longer exists.";
  else if (team) blocked = "This item is no longer available.";
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    try {
      await remove.mutateAsync({ id });
      close();
      useRouter.getState().closeThreadPane(id);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  };
  const error = failure;
  return (
    <>
      <p className="text-base text-ink-2 mb-4">{copy}</p>
      {blocked ? (
        <p role="status" className="text-sm text-ink-3 mb-3">
          {blocked}
        </p>
      ) : null}

      {error ? (
        <div role="alert" className="text-sm text-bad mb-3 break-words">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button onClick={close}>{"Cancel"}</Button>
        <Button variant="danger" disabled={remove.isPending || Boolean(blocked)} onClick={() => void run()}>
          {remove.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </>
  );
}
