import { canMoveToCloud, cloudServiceMissing, offersBrainMove, threadPlace } from "@openorc/client";
import type { CloudOffer, ThreadSummary, WorktreeBlock } from "@openorc/protocol";
import { WORKSPACE_ID, WORKTREE_BLOCK_WORDS } from "@openorc/protocol";
import type { ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { useUi } from "../lib/ui";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronRight, Cloud, Copy, Folder, GitBranch, GitPullRequest, Laptop, Trash2 } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import type { MenuParts } from "./ThreadActions";
import { machine, revealLabel, ThisComputer, thisComputer } from "../lib/this-computer";

type Where = "moving" | "cloud" | "mac";

/** Where the next turn runs, when the menu has a move to offer from there: this Mac only when the cloud is an option. */
function whereKind(thread: ThreadSummary, offer: CloudOffer | undefined): Where | null {
  if (thread.moving) return "moving";
  if (thread.owner?.brain === "cloud") return "cloud";
  if (!offer) return null;
  return (offer.brain ? offersBrainMove(thread) : canMoveToCloud(thread)) ? "mac" : null;
}

/**
 * The top of a thread's menu: where it works. Its branch, in a worktree or the checkout, then this Mac or the cloud.
 * Each row's submenu holds the moves away from there, so the menu below is only about the conversation.
 */
export function ThreadPlaceItems({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const offer = useRpc("cloud.offer", {}).data;
  const branch = thread.projectId !== WORKSPACE_ID;
  const where = whereKind(thread, offer);
  if (!branch && !where) return null;
  return (
    <>
      {branch ? <BranchRow thread={thread} parts={M} /> : null}
      {where === "moving" ? <MovingRow thread={thread} parts={M} /> : null}
      {where === "cloud" ? <CloudRow thread={thread} parts={M} /> : null}
      {where === "mac" ? <MacRow thread={thread} parts={M} offer={offer} /> : null}
      <M.Separator className={menuSeparator} />
    </>
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
  const here = thread.owner?.brain !== "cloud";
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
      {here ? <MoveFolderItem thread={thread} parts={M} /> : null}
      {here && thread.workspaceMode === "worktree" && thread.worktreePath && thread.parentRelation !== "subagent" ? <RemoveWorktreeItem thread={thread} parts={M} /> : null}
    </PlaceRow>
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
  if (thread.cloud) return "cloud";
  return thread.activity !== "idle" || thread.backgroundCommands?.length || thread.moving ? "working" : null;
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

function MenuError({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="max-w-64 px-2 py-1 text-xs text-bad break-words">
      {error.message}
    </p>
  ) : null;
}

function MovingRow({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const keep = useRpcMutation("cloud.keep");
  const toCloud = thread.moving?.to === "cloud";
  return (
    <PlaceRow parts={M} icon={<Cloud size={13} />} label={toCloud ? "Moving to the cloud" : `Moving to ${thisComputer}`}>
      <MenuError error={keep.error} />
      <M.Item className={menuItem} disabled={keep.isPending} onClick={() => keep.mutate({ threadId: thread.id })}>
        {toCloud ? <Laptop size={13} /> : <Cloud size={13} />} {toCloud ? `Keep on ${thisComputer}` : "Keep in the cloud"}
      </M.Item>
    </PlaceRow>
  );
}

function CloudRow({ thread, parts: M }: { thread: ThreadSummary; parts: MenuParts }) {
  const bring = useRpcMutation("cloud.bringToMac");
  const openCopy = useRpcMutation("cloud.openOnMac");
  const closeCopy = useRpcMutation("cloud.closeOnMac");
  const mirrored = Boolean(thread.owner?.mirror);
  return (
    <PlaceRow parts={M} icon={<Cloud size={13} />} label="Cloud">
      <MenuError error={bring.error ?? openCopy.error ?? closeCopy.error} />
      <M.Item className={menuItem} disabled={thread.activity !== "idle" || bring.isPending} onClick={() => bring.mutate({ threadId: thread.id })}>
        <Laptop size={13} /> Bring to {machine}
      </M.Item>
      <M.Item className={menuItem} disabled={openCopy.isPending || closeCopy.isPending} onClick={() => (mirrored ? closeCopy : openCopy).mutate({ threadId: thread.id })}>
        <Folder size={13} /> {mirrored ? `Close on ${machine}` : `Open on ${machine}`}
      </M.Item>
    </PlaceRow>
  );
}

/** With a cloud brain, the move is the brain's and may be refused with its reason; without one, today's sandbox move. */
function MacRow({ thread, parts: M, offer }: { thread: ThreadSummary; parts: MenuParts; offer: CloudOffer | undefined }) {
  const missing = cloudServiceMissing(offer);
  return (
    <PlaceRow parts={M} icon={<Laptop size={13} />} label={ThisComputer}>
      <M.Item className={menuItem} disabled={thread.activity !== "idle" || Boolean(missing)} data-tip={missing ?? undefined} onClick={() => useUi.getState().setMoveThread(thread.id, "cloud")}>
        <Cloud size={13} /> Move to cloud
      </M.Item>
    </PlaceRow>
  );
}
