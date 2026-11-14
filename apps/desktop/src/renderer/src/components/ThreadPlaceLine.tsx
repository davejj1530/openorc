import { Menu } from "@base-ui/react/menu";
import { ownerMark } from "@openorc/client";
import { placeOf, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import type { ComponentType, ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { ChevronDown, Cloud, Folder, GitBranch } from "./icons";
import { menuPopup } from "./menu";
import type { PickerAccounts } from "./ModelPickerAccounts";
import { ThreadPlaceItems } from "./ThreadPlaceItems";

type Where = "checkout" | "worktree" | "own-cloud" | "hosted" | "folder";

/** The same glyph each place has in New thread's place menu and on a thread's row. */
const GLYPHS: Record<Where, ComponentType<{ size?: number }>> = { checkout: GitBranch, worktree: Folder, "own-cloud": Cloud, hosted: Cloud, folder: Folder };

function whereOf(thread: ThreadSummary): Where {
  if (thread.owner?.brain === "hosted") return "hosted";
  if (placeOf(thread).brain || thread.cloud) return "own-cloud";
  if (thread.projectId === WORKSPACE_ID) return "folder";
  return thread.workspaceMode === "worktree" ? "worktree" : "checkout";
}

/** Where a started thread works, in New thread's words with the branch it is on now in place of the one it starts from. */
function sentence(where: Where, branch: string | null, folder: string | null): ReactNode {
  const on = (lead: string) =>
    branch ? (
      <>
        {lead}
        <span className="composer-branch">{branch}</span>
      </>
    ) : null;
  switch (where) {
    case "checkout":
      return <>Works in the local checkout{on(" on ")}</>;
    case "worktree":
      return <>Works in a worktree{on(" on ")}</>;
    case "own-cloud":
      return <>Works in your own cloud{on(", on ")}</>;
    case "hosted":
      return <>Works on OpenOrc Cloud{on(", on ")}</>;
    case "folder":
      return <>Works in {folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? "its folder"}</>;
  }
}

/**
 * Under a started thread's composer: where it works, led by its place's glyph, with this Mac's account it runs on at
 * the line's end. Pressing it opens the place's actions, as the thread's menu holds them; a folder outside any project has
 * none, so it is only said. A thread whose place cannot be reached reads dimmed.
 */
export function ThreadPlaceLine({ thread, accounts }: { thread: ThreadSummary; accounts?: PickerAccounts | undefined }) {
  const where = whereOf(thread);
  // OpenOrc Cloud runs a turn on its own sign-ins, never one of this Mac's accounts.
  const account = where === "hosted" ? undefined : accounts?.accounts.find((each) => each.id === accounts.current)?.name;
  const Glyph = GLYPHS[where];
  const checkout = where === "checkout";
  const live = useRpc("projects.checkoutBranch", { id: thread.projectId }, { enabled: checkout, staleTime: 0 });
  const branch = checkout && live.isSuccess ? (live.data ?? null) : (thread.branch ?? null);
  const words = sentence(where, branch, thread.workingDirectory ?? null);
  return (
    <div className="thread-place-line" data-dim={ownerMark(thread)?.dim || undefined}>
      {where === "folder" ? (
        <span className="thread-place-fact">
          <Glyph size={14} />
          <span className="new-thread-sentence">{words}</span>
        </span>
      ) : (
        <Menu.Root>
          <Menu.Trigger aria-label="Where the thread works" className="composer-text-choice">
            <Glyph size={14} />
            <span className="new-thread-sentence">{words}</span>
            <ChevronDown size={12} className="composer-chip-chevron" />
          </Menu.Trigger>
          <Menu.Portal>
            <CoversPreview />
            <Menu.Positioner side="top" align="start" sideOffset={6} collisionPadding={8}>
              <Menu.Popup ref={floatingGround} className={`${menuPopup} thread-place-menu`}>
                <ThreadPlaceItems thread={thread} parts={Menu} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
      {account ? <span className="thread-place-account">{account}</span> : null}
    </div>
  );
}
