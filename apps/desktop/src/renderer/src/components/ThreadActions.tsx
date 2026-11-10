import { Menu } from "@base-ui/react/menu";
import { snoozePresets, threadResolved } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { isSubagentThread, forkUnavailable } from "@openorc/protocol";
import { useRef, useState } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { afterOrclingChatDeleted, orclingHome, useOrclingGroups, useOrclings } from "../lib/orclings";
import { MAX_THREAD_PANES, newSubthread, openThread, useRouter } from "../lib/router";
import { useThreadMutationPending } from "../lib/thread-mutations";
import { useThreadTabs } from "../lib/thread-tabs";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { AlarmClock, AppWindow, ChevronRight, CircleCheck, Columns2, GitFork, MailOpen, PenSquare, Pencil, Pin, PinOff, RotateCcw, SquarePlus, Trash2 } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { ThreadPlaceItems } from "./ThreadPlaceItems";
import { Button, Dialog } from "./ui";

/** The parts a dropdown and a context menu share, so one item list serves both. */
export type MenuParts = Pick<typeof Menu, "Item" | "Separator" | "SubmenuRoot" | "SubmenuTrigger" | "Portal" | "Positioner" | "Popup">;

/**
 * Where the menu opens. The header's thread is open right there, so opening it again, its parent (the header shows
 * that link) and marking it unread (looking at it reads it) drop out; Rename joins in. A sidebar row keeps them all.
 */
type ItemsProps = { thread: ThreadSummary; parts: MenuParts; header?: boolean; onRename?: () => void };

/** Every action a thread has, as menu items. The same list serves the header menu and the sidebar's context menu. */
export function ThreadMenuItems({ thread, parts: M, header, onRename }: ItemsProps) {
  const home = orclingHome(useOrclings(), thread.id);
  if (isSubagentThread(thread))
    return (
      <>
        {header ? <OpenWindowItem thread={thread} parts={M} /> : <OpenItems thread={thread} parts={M} />}
        {thread.subagent?.status !== "running" && thread.activity === "idle" ? (
          <M.Item className={menuItemDanger} onClick={() => useUi.getState().setDeleteThread(thread.id)}>
            <Trash2 size={13} /> Delete
          </M.Item>
        ) : null}
      </>
    );
  // An Orcling's own conversation lives and goes with the Orcling, which you change in its designer.
  if (home) {
    return (
      <>
        {onRename ? <RenameItem parts={M} onRename={onRename} /> : null}
        <M.Item className={menuItem} onClick={() => useRouter.getState().navigate({ view: "orcling", orclingId: home.id })}>
          <Pencil size={13} /> Edit {home.name}
        </M.Item>
      </>
    );
  }
  return <ThreadMenuContent key={thread.id} thread={thread} parts={M} header={header} onRename={onRename} />;
}

function RenameItem({ parts: M, onRename }: { parts: MenuParts; onRename: () => void }) {
  return (
    <M.Item className={menuItem} onClick={onRename}>
      <Pencil size={13} /> Rename
    </M.Item>
  );
}

/** A sidebar row's ways to look at its thread, without leaving the one in front. */
function OpenItems({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const cannotSplit = useRouter((s) => s.threadIds.includes(thread.id) || s.threadIds.length >= MAX_THREAD_PANES);
  const parent = thread.parentThreadId;
  return (
    <>
      <M.Item className={menuItem} onClick={() => useThreadTabs.getState().openThread(thread.id)}>
        <SquarePlus size={13} /> Open in new tab
      </M.Item>
      <M.Item className={menuItem} disabled={cannotSplit} onClick={() => useRouter.getState().addThreadPane(thread.id)}>
        <Columns2 size={13} /> Open beside
      </M.Item>
      <OpenWindowItem thread={thread} parts={M} />
      {parent ? (
        <M.Item className={menuItem} onClick={() => openThread(parent)}>
          Open parent
        </M.Item>
      ) : null}
    </>
  );
}

function ThreadMenuContent({ thread, parts: M, header, onRename }: ItemsProps) {
  const update = useRpcMutation("threads.update");
  const patch = (p: Parameters<typeof update.mutate>[0]["patch"]) => update.mutate({ id: thread.id, patch: p });
  // Mutations can outlive a closed menu. Reopening it must not enable sibling writes.
  const mutating = useThreadMutationPending(thread.id);

  return (
    <>
      {header ? null : (
        <>
          <NewSubthreadItem thread={thread} parts={M} />
          <OpenItems thread={thread} parts={M} />
          <M.Separator className={menuSeparator} />
        </>
      )}
      <ThreadPlaceItems thread={thread} parts={M} />
      {update.error ? (
        <div className="max-w-64 px-2 py-1 text-xs text-bad break-words" role="alert">
          {update.error.message}
        </div>
      ) : null}
      {onRename ? <RenameItem parts={M} onRename={onRename} /> : null}
      <M.Item className={menuItem} disabled={mutating} onClick={() => patch({ pinned: !thread.pinnedAt })}>
        {thread.pinnedAt ? <PinOff size={13} /> : <Pin size={13} />} {thread.pinnedAt ? "Unpin" : "Pin"}
      </M.Item>
      <SnoozeItem thread={thread} parts={M} disabled={mutating} patch={patch} />
      {header ? null : (
        <M.Item className={menuItem} disabled={mutating} onClick={() => patch({ seen: thread.unread })}>
          <MailOpen size={13} /> {thread.unread ? "Mark as read" : "Mark as unread"}
        </M.Item>
      )}
      <M.Separator className={menuSeparator} />
      <ThreadForkActions thread={thread} parts={M} header={header} />
      {header ? <OpenWindowItem thread={thread} parts={M} /> : null}
      <M.Separator className={menuSeparator} />
      <LifecycleItems thread={thread} parts={M} disabled={mutating} patch={patch} />
    </>
  );
}

function OpenWindowItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  return (
    <M.Item className={menuItem} onClick={() => window.openorc.openWindow(`thread:${thread.id}`)}>
      <AppWindow size={13} /> Open in new window
    </M.Item>
  );
}

type Patch = (patch: { snoozedUntil?: number | null; archived?: boolean }) => void;

function SnoozeItem({ thread, parts: M, disabled, patch }: { thread: ThreadSummary; parts: MenuParts; disabled: boolean; patch: Patch }) {
  return (
    <M.SubmenuRoot>
      <M.SubmenuTrigger className={menuItem} disabled={disabled}>
        <AlarmClock size={13} /> {thread.snoozedUntil ? "Snoozed" : "Snooze"}
        <ChevronRight size={14} className="ml-auto" />
      </M.SubmenuTrigger>
      <M.Portal>
        <CoversPreview />
        <M.Positioner sideOffset={4} alignOffset={-6} collisionPadding={8}>
          <M.Popup ref={floatingGround} className={menuPopup}>
            {snoozePresets().map((p) => (
              <M.Item key={p.label} className={menuItem} disabled={disabled} closeOnClick onClick={() => patch({ snoozedUntil: p.until(new Date()) })}>
                {p.label}
              </M.Item>
            ))}
            {thread.snoozedUntil ? (
              <>
                <M.Separator className={menuSeparator} />
                <M.Item className={menuItem} disabled={disabled} closeOnClick onClick={() => patch({ snoozedUntil: null })}>
                  Wake now
                </M.Item>
              </>
            ) : null}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.SubmenuRoot>
  );
}

function LifecycleItems({ thread, parts: M, disabled, patch }: { thread: ThreadSummary; parts: MenuParts; disabled: boolean; patch: Patch }) {
  const resolved = threadResolved(thread, Date.now());
  const team = Boolean(thread.teamInstanceId);
  return (
    <>
      <M.Item className={menuItem} disabled={disabled} closeOnClick onClick={() => patch({ archived: !resolved })}>
        {resolved ? <RotateCcw size={13} /> : <CircleCheck size={13} />} {resolved ? "Reopen" : "Resolve"}
      </M.Item>
      <M.Item className={menuItemDanger} disabled={team || disabled} title={team ? "This item is no longer available." : undefined} onClick={() => useUi.getState().setDeleteThread(thread.id)}>
        <Trash2 size={13} /> Delete
      </M.Item>
    </>
  );
}

/** A sidebar row's menu leads with it; the header's keeps it beside Fork. */
function NewSubthreadItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const inCloud = thread.owner?.brain === "cloud";
  return (
    <M.Item className={menuItem} disabled={Boolean(thread.teamInstanceId) || inCloud} title={inCloud ? "Bring it to this Mac first." : undefined} onClick={() => newSubthread(thread.id)}>
      <PenSquare size={13} /> New subthread
    </M.Item>
  );
}

function ThreadForkActions({ thread, parts: M, header }: { thread: ThreadSummary; parts: MenuParts; header?: boolean }) {
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
      {header ? <NewSubthreadItem thread={thread} parts={M} /> : null}
      <M.Item
        className={menuItem}
        disabled={Boolean(thread.teamInstanceId) || inCloud || mutating || fork.isPending || Boolean(forkUnavailable(thread.agent))}
        title={inCloud ? "Bring it to this Mac first." : (forkUnavailable(thread.agent) ?? undefined)}
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
  const orclings = useOrclings();
  const groups = useOrclingGroups();
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
      const router = useRouter.getState();
      // A group chat goes the way an Orcling does: you stay among your Orclings, on the chat beside it.
      if (groups.some((group) => group.threadId === id) && router.threadIds.length <= 1) router.navigate(afterOrclingChatDeleted(orclings, groups, id));
      else router.closeThreadPane(id);
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
