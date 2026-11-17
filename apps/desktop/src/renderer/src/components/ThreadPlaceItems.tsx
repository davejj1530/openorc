import { threadPlace } from "@openorc/client";
import type { ThreadSummary, WorktreeBlock } from "@openorc/protocol";
import { movingHold, placeOf, WORKSPACE_ID, WORKTREE_BLOCK_WORDS } from "@openorc/protocol";
import { useCloudMove, useStartCloudMove } from "./CloudMoveDialog";
import { HostedMenuReason } from "./HostedMenuReason";
import type { ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronRight, Cloud, Copy, Folder, GitBranch, GitPullRequest, Laptop, Trash2 } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import type { MenuParts } from "./ThreadActions";
import { machine, revealLabel } from "../lib/this-computer";

/**
 * The top of a thread's menu: where it works. Its branch, in a worktree or the checkout, then OpenOrc Cloud for a
 * thread there. Each row's submenu holds the moves away from there, so the menu below is only about the conversation.
 * A thread moving between this computer and the cloud says where it is going, and nothing else, until it is there.
 */
export function ThreadPlaceItems({ thread, parts: M, close }: { thread: ThreadSummary; parts: MenuParts; close?: (() => void) | undefined }) {
  const branch = thread.projectId !== WORKSPACE_ID;
  const hosted = thread.owner?.brain === "hosted";
  const moving = movingHold(thread.moving, machine);
  if (!branch && !hosted) return null;
  return (
    <>
      {moving ? (
        <M.Item className={menuItem} disabled>
          {thread.moving?.to === "cloud" ? <Cloud size={13} /> : <Laptop size={13} />} {moving}
        </M.Item>
      ) : (
        <>
          {branch ? <BranchRow thread={thread} parts={M} /> : null}
          {hosted ? <HostedPlaceRow thread={thread} parts={M} close={close} /> : null}
        </>
      )}
      <M.Separator className={menuSeparator} />
    </>
  );
}

function HostedPlaceRow({ thread, parts: M, close }: { thread: ThreadSummary; parts: MenuParts; close: (() => void) | undefined }) {
  return (
    <PlaceRow parts={M} icon={<Cloud size={13} />} label="OpenOrc Cloud">
      <CloudMoveItem thread={thread} parts={M} />
      <OpenHereItem thread={thread} parts={M} close={close} />
    </PlaceRow>
  );
}

/**
 * Shows the thread's code here without moving it: a copy of its newest save, made or brought up to date, then opened in
 * the file manager. Held with why when it can't be made (its project isn't here, it has no save yet).
 */
function OpenHereItem({ thread, parts: M, close }: { thread: ThreadSummary; parts: MenuParts; close: (() => void) | undefined }) {
  const copy = useRpcMutation("threads.cloudCopy");
  const label = (
    <>
      <Folder size={13} /> {copy.isPending ? "Opening…" : `Open on ${machine}`}
    </>
  );
  if (copy.error)
    return (
      <HostedMenuReason parts={M} reason={copy.error.message}>
        {label}
      </HostedMenuReason>
    );
  return (
    <M.Item
      className={menuItem}
      closeOnClick={false}
      disabled={copy.isPending}
      onClick={() =>
        copy.mutate(
          { threadId: thread.id },
          {
            onSuccess: (made) => {
              window.openorc.revealFile(made.folder);
              close?.();
            },
          },
        )
      }
    >
      {label}
    </M.Item>
  );
}

/** Moves the thread between this computer and OpenOrc Cloud, by way of one confirm; held, with why, when it can't go now. */
function CloudMoveItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const offer = useCloudMove(thread);
  const start = useStartCloudMove();
  const hosted = thread.owner?.brain === "hosted";
  if (!offer && !hosted) return null;
  const label = hosted ? (
    <>
      <Laptop size={13} /> Move to {machine}
    </>
  ) : (
    <>
      <Cloud size={13} /> Move to OpenOrc Cloud
    </>
  );
  if (offer?.held)
    return (
      <HostedMenuReason parts={M} reason={offer.held}>
        {label}
      </HostedMenuReason>
    );
  return (
    <M.Item className={menuItem} disabled={!offer} onClick={() => start(thread.id, offer)}>
      {label}
    </M.Item>
  );
}

/** A row that says where the thread is, its chevron opening what can be done about that. */
function PlaceRow({ parts: M, icon, label, title, tag, children }: { parts: MenuParts; icon: ReactNode; label: string; title?: string; tag?: string; children: ReactNode }) {
  return (
    <M.SubmenuRoot>
      <M.SubmenuTrigger className={menuItem} data-tip={title}>
        {icon}
        <span className="min-w-0 max-w-56 truncate">{label}</span>
        {tag ? <span className="ml-auto pl-4 text-sm text-ink-4">{tag}</span> : null}
        <ChevronRight size={14} className={tag ? undefined : "ml-auto"} />
      </M.SubmenuTrigger>
      <M.Portal>
        <CoversPreview />
        <M.Positioner sideOffset={4} alignOffset={-6} collisionPadding={8}>
          <M.Popup ref={floatingGround} className={menuPopup}>
            {children}
          </M.Popup>
        </M.Positioner>
      </M.Portal>
    </M.SubmenuRoot>
  );
}

const placeIcons = { branch: GitBranch, pull: GitPullRequest, folder: Folder } as const;

/** The branch the thread works on, read live from the checkout since the checkout can switch under it, and the folder it works in on this Mac. */
function useBranchPlace(thread: ThreadSummary) {
  const checkout = thread.workspaceMode === "current";
  const here = !placeOf(thread).elsewhere;
  const live = useRpc("projects.checkoutBranch", { id: thread.projectId }, { enabled: checkout && here, staleTime: 0 });
  const project = useRpc("projects.get", { id: thread.projectId }, { enabled: checkout && here });
  const place = threadPlace({ ...thread, branch: checkout && live.isSuccess ? live.data : thread.branch });
  const root = checkout ? project.data?.rootPath : undefined;
  const folder = here ? (thread.worktreePath ?? root ?? null) : null;
  return { place, folder, here, tag: checkout ? "Checkout" : "Worktree" };
}

function BranchRow({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const { place, folder, here, tag } = useBranchPlace(thread);
  const Icon = placeIcons[place.kind];
  const branch = place.kind === "branch" ? place.label : null;
  const above = Boolean(folder || branch);
  if (!above && !here) return null;
  return (
    <PlaceRow parts={M} icon={<Icon size={13} />} label={place.label} title={folder ?? undefined} tag={tag}>
      {folder ? (
        <M.Item className={menuItem} onClick={() => window.openorc.revealFile(folder)}>
          <Folder size={13} /> {revealLabel()}
        </M.Item>
      ) : null}
      {branch ? (
        <M.Item className={menuItem} onClick={() => void navigator.clipboard.writeText(branch)}>
          <Copy size={13} /> Copy branch name
        </M.Item>
      ) : null}
      {here && above ? <M.Separator className={menuSeparator} /> : null}
      {here ? <MovesHere thread={thread} parts={M} /> : null}
    </PlaceRow>
  );
}

/** The moves of a thread working on this computer: between the checkout and a worktree, out of its worktree, to the cloud. */
function MovesHere({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  return (
    <>
      <MoveFolderItem thread={thread} parts={M} />
      {thread.workspaceMode === "worktree" && thread.worktreePath && thread.parentRelation !== "subagent" ? <RemoveWorktreeItem thread={thread} parts={M} /> : null}
      <CloudMoveItem thread={thread} parts={M} />
    </>
  );
}

/** Between the checkout and a worktree of its own; the dialog says what happens to the files. */
function MoveFolderItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const team = Boolean(thread.teamInstanceId);
  const toCheckout = thread.workspaceMode === "worktree";
  return (
    <M.Item
      className={menuItem}
      disabled={team || thread.activity !== "idle"}
      data-tip={team ? "This item is no longer available." : undefined}
      onClick={() => useUi.getState().setMoveThread(thread.id)}
    >
      {toCheckout ? <Laptop size={13} /> : <GitBranch size={13} />} {toCheckout ? "Move to the checkout" : "Move to a worktree"}
    </M.Item>
  );
}

/** What the summary already shows of why the core would refuse the removal; the core decides the rest. */
function removalBlock(thread: ThreadSummary): WorktreeBlock | null {
  return thread.activity !== "idle" || thread.backgroundCommands?.length ? "working" : null;
}

/** Frees the folder on disk; the branch and conversation stay, and the next message makes the worktree again. */
function RemoveWorktreeItem({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const block = removalBlock(thread);
  return (
    <M.Item className={menuItem} disabled={block !== null} data-tip={block ? WORKTREE_BLOCK_WORDS[block] : undefined} onClick={() => useUi.getState().setRemoveWorktree(thread.id)}>
      <Trash2 size={13} /> Remove worktree
    </M.Item>
  );
}
