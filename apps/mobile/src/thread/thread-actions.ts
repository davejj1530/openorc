import { fileCount, panelToolLabels, snoozePresets, threadResolved } from "@openorc/client";
import { isSubagentThread, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import type { Link } from "expo-router";
import type { ComponentProps } from "react";

/** The changes a phone may make to how a thread is organized. */
export type OrganizePatch = Pick<RpcParams<"threads.update">["patch"], "pinned" | "archived" | "snoozedUntil" | "seen">;

type Symbol = NonNullable<ComponentProps<typeof Link.MenuAction>["icon"]>;

/** The screens a thread's menu opens over the thread: the desktop's side panel tools a phone has, and the move to the cloud. */
export type ThreadScreenPath = "/changes" | "/preview" | "/move-to-cloud";

/**
 * One item of a thread's menu: a change to save, a snooze (its time counted when it is chosen, as a row keeps its menu
 * for hours), a submenu of them, a rename, the thread's pull request, or one of the thread's screens.
 */
export type ThreadAction =
  | { kind: "patch"; label: string; icon: Symbol; patch: OrganizePatch }
  | { kind: "snooze"; label: string; icon: Symbol; until: (chosenAt: Date) => number }
  | { kind: "menu"; label: string; icon: Symbol; actions: ThreadAction[] }
  | { kind: "rename"; label: string; icon: Symbol }
  | { kind: "open"; label: string; icon: Symbol; url: string }
  | { kind: "parent"; label: string; icon: Symbol; threadId: string }
  | { kind: "screen"; label: string; icon: Symbol; subtitle?: string; pathname: ThreadScreenPath }
  /** Asked of the Mac `mac`, which moves every thread between itself and its cloud brain. */
  | { kind: "move"; label: string; icon: Symbol; method: "cloud.bringToMac" | "cloud.keep"; mac: string };

/** Where the menu opens: a Home row (long press), or the open thread's header, where Rename leads after Changes. */
export type MenuPlace = "row" | "header";

function snooze(thread: ThreadSummary, now: Date): ThreadAction {
  const presets = snoozePresets(now).map((preset): ThreadAction => ({ kind: "snooze", label: preset.label, icon: "clock", until: preset.until }));
  const snoozed = Boolean(thread.snoozedUntil && thread.snoozedUntil > now.getTime());
  const wake: ThreadAction[] = snoozed ? [{ kind: "patch", label: "Wake Now", icon: "sun.max", patch: { snoozedUntil: null } }] : [];
  return { kind: "menu", label: snoozed ? "Snoozed" : "Snooze", icon: "moon.zzz", actions: [...presets, ...wake] };
}

/**
 * The side panel tools the header lists: `uncommitted` is the Changes file count, null without Git; `preview` names
 * the page the Mac shows for the thread, `page: null` while it shows none, and is null for a Mac that cannot show one.
 * `toCloud` offers to move the thread to a sandbox of its own.
 */
export interface ThreadPanels {
  uncommitted: number | null;
  preview: { page: string | null } | null;
  toCloud?: boolean;
  /** The Mac grouped with its cloud brain, which brings the brain's threads home; null without both. */
  moves?: { mac: string; onBrain: boolean } | null;
}

const NO_PANELS: ThreadPanels = { uncommitted: null, preview: null };

/** Preview, with the page the Mac shows beneath it when there is one. */
function preview(page: string | null): ThreadAction {
  const item: ThreadAction = { kind: "screen", label: panelToolLabels.browser, icon: "globe", pathname: "/preview" };
  return page ? { ...item, subtitle: page } : item;
}

/** Bring to Mac for an idle thread on the cloud brain, and Keep where it is while a thread moves. */
function brainMoves(thread: ThreadSummary, moves: ThreadPanels["moves"]): ThreadAction[] {
  if (!moves) return [];
  const { mac } = moves;
  if (thread.moving) {
    const toMac = thread.moving.to === "mac";
    return [{ kind: "move", label: toMac ? "Keep in Cloud" : "Keep on Mac", icon: toMac ? "icloud" : "laptopcomputer", method: "cloud.keep", mac }];
  }
  return moves.onBrain && thread.activity === "idle" ? [{ kind: "move", label: "Bring to Mac", icon: "laptopcomputer.and.arrow.down", method: "cloud.bringToMac", mac }] : [];
}

/** Changes, with the uncommitted file count beneath it when there is one. */
function changes(files: number): ThreadAction {
  const item: ThreadAction = { kind: "screen", label: panelToolLabels.changes, icon: "plus.forwardslash.minus", pathname: "/changes" };
  return files ? { ...item, subtitle: fileCount(files) } : item;
}

/**
 * What a paired phone may do to a thread, in the desktop menu's order and sections: pin, snooze, read state; rename and
 * the pull request and the move to the cloud; archive. A team thread's lifecycle (snooze, archive) stays with the team
 * on the Mac. Deleting, forking and moving within the Mac stay there. The header leads with the thread's panels, Changes then Preview: every thread
 * action lives in the More menu, so the title keeps the header's center.
 */
export function threadMenu(thread: ThreadSummary, place: MenuPlace, now: Date, panels: ThreadPanels = NO_PANELS): ThreadAction[][] {
  if (isSubagentThread(thread)) return thread.parentThreadId ? [[{ kind: "parent", label: "Open parent", icon: "arrow.turn.up.left", threadId: thread.parentThreadId }]] : [];
  const team = Boolean(thread.teamInstanceId);
  const rename: ThreadAction = { kind: "rename", label: "Rename…", icon: "pencil" };
  const screens: ThreadAction[] = [...(panels.uncommitted === null ? [] : [changes(panels.uncommitted)]), ...(panels.preview ? [preview(panels.preview.page)] : [])];
  const organize: ThreadAction[] = [
    thread.pinnedAt ? { kind: "patch", label: "Unpin", icon: "pin.slash", patch: { pinned: false } } : { kind: "patch", label: "Pin", icon: "pin", patch: { pinned: true } },
    ...(team ? [] : [snooze(thread, now)]),
    thread.unread ? { kind: "patch", label: "Mark as Read", icon: "envelope.open", patch: { seen: true } } : { kind: "patch", label: "Mark as Unread", icon: "envelope.badge", patch: { seen: false } },
  ];
  const pull: ThreadAction[] = thread.prUrl ? [{ kind: "open", label: "Open Pull Request", icon: "arrow.up.right.square", url: thread.prUrl }] : [];
  const move: ThreadAction[] = [
    ...(panels.toCloud ? [{ kind: "screen", label: "Move to Cloud", icon: "icloud.and.arrow.up", pathname: "/move-to-cloud" } as const] : []),
    ...brainMoves(thread, panels.moves),
  ];
  const resolve: ThreadAction[] = team
    ? []
    : [
        threadResolved(thread, now.getTime())
          ? { kind: "patch", label: "Reopen", icon: "arrow.uturn.backward.circle", patch: { archived: false } }
          : { kind: "patch", label: "Resolve", icon: "checkmark.circle", patch: { archived: true } },
      ];
  const sections = place === "header" ? [[...screens, rename], organize, [...pull, ...move], resolve] : [organize, [rename, ...pull], resolve];
  return sections.filter((section) => section.length > 0);
}

type Swipe = { label: string; patch: OrganizePatch };

/** A Home row's two swipes, as Mail's: leading marks read or unread, trailing resolves or reopens (not a team's thread). */
export function threadSwipes(thread: ThreadSummary, now = Date.now()): { leading: Swipe; trailing: Swipe | null } {
  const leading: Swipe = thread.unread ? { label: "Read", patch: { seen: true } } : { label: "Unread", patch: { seen: false } };
  if (thread.teamInstanceId || isSubagentThread(thread)) return { leading, trailing: null };
  return { leading, trailing: threadResolved(thread, now) ? { label: "Reopen", patch: { archived: false } } : { label: "Resolve", patch: { archived: true } } };
}
