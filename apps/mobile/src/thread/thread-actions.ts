import { fileCount, panelToolLabels, snoozePresets, threadResolved } from "@openorc/client";
import { isSubagentThread, placeOf, type RpcParams, type ThreadSummary } from "@openorc/protocol";
import type { Link } from "expo-router";
import type { ComponentProps } from "react";

/** The changes a phone may make to how a thread is organized. */
export type OrganizePatch = Pick<RpcParams<"threads.update">["patch"], "pinned" | "archived" | "snoozedUntil" | "seen">;

type Symbol = NonNullable<ComponentProps<typeof Link.MenuAction>["icon"]>;

/** The screens a thread's menu opens over the thread: the desktop's side panel tools a phone has. */
export type ThreadScreenPath = "/changes" | "/cloud-changes" | "/preview" | "/subthreads" | "/new-subthread";

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
  | { kind: "delete"; label: string; icon: Symbol };

/** What deleting a cloud thread removes, in the desktop's words, asked before it goes. */
export const DELETE_CLOUD_THREAD = "The conversation and its work on OpenOrc Cloud are removed, for everyone in it.";

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
 */
export interface ThreadPanels {
  uncommitted: number | null;
  preview: { page: string | null } | null;
  /** How many threads were started from this one. */
  subthreads?: number;
}

const NO_PANELS: ThreadPanels = { uncommitted: null, preview: null };

/** Preview, with the page the Mac shows beneath it when there is one. */
function preview(page: string | null): ThreadAction {
  const item: ThreadAction = { kind: "screen", label: panelToolLabels.browser, icon: "globe", pathname: "/preview" };
  return page ? { ...item, subtitle: page } : item;
}

/** Changes, with the file count beneath it when there is one: a cloud thread's open OpenOrc Cloud's own. */
function changes(files: number, cloud: boolean): ThreadAction {
  const item: ThreadAction = { kind: "screen", label: panelToolLabels.changes, icon: "plus.forwardslash.minus", pathname: cloud ? "/cloud-changes" : "/changes" };
  return files ? { ...item, subtitle: fileCount(files) } : item;
}

/**
 * What a paired phone may do to a thread, in the desktop menu's order and sections: a row's menu leads with New
 * Subthread, the header's keeps it with the thread's family; pin, snooze, read state; rename and
 * the pull request; archive. A team thread's lifecycle (snooze, archive) stays with the team
 * on the Mac. Deleting, forking and moving within the Mac stay there. The header leads with the thread's panels, Changes then Preview: every thread
 * action lives in the More menu, so the title keeps the header's center.
 */
export function threadMenu(thread: ThreadSummary, place: MenuPlace, now: Date, panels: ThreadPanels = NO_PANELS): ThreadAction[][] {
  if (isSubagentThread(thread)) return thread.parentThreadId ? [[{ kind: "parent", label: "Open parent", icon: "arrow.turn.up.left", threadId: thread.parentThreadId }]] : [];
  const team = Boolean(thread.teamInstanceId);
  const rename: ThreadAction = { kind: "rename", label: "Rename…", icon: "pencil" };
  const screens: ThreadAction[] = [...(panels.uncommitted === null ? [] : [changes(panels.uncommitted, placeOf(thread).elsewhere)]), ...(panels.preview ? [preview(panels.preview.page)] : [])];
  const organize: ThreadAction[] = [
    thread.pinnedAt ? { kind: "patch", label: "Unpin", icon: "pin.slash", patch: { pinned: false } } : { kind: "patch", label: "Pin", icon: "pin", patch: { pinned: true } },
    ...(team ? [] : [snooze(thread, now)]),
    thread.unread ? { kind: "patch", label: "Mark as Read", icon: "envelope.open", patch: { seen: true } } : { kind: "patch", label: "Mark as Unread", icon: "envelope.badge", patch: { seen: false } },
  ];
  const pull: ThreadAction[] = thread.prUrl ? [{ kind: "open", label: "Open Pull Request", icon: "arrow.up.right.square", url: thread.prUrl }] : [];
  const resolve: ThreadAction[] = team
    ? []
    : [
        threadResolved(thread, now.getTime())
          ? { kind: "patch", label: "Reopen", icon: "arrow.uturn.backward.circle", patch: { archived: false } }
          : { kind: "patch", label: "Resolve", icon: "checkmark.circle", patch: { archived: true } },
      ];
  // A cloud thread is deleted for everyone in it, from wherever its menu opens; a thread of the Mac's only on the Mac.
  const remove: ThreadAction[] = placeOf(thread).elsewhere ? [{ kind: "delete", label: "Delete…", icon: "trash" }] : [];
  const sections = place === "header" ? [[...screens, rename], family(thread, panels), organize, pull, resolve, remove] : [startUnder(thread), organize, [rename, ...pull], resolve, remove];
  return sections.filter((section) => section.length > 0);
}

/**
 * New Subthread, as the desktop's menus offer it: a thread started under this one, in its folder. A team's thread and
 * an Orcling's conversation start none from a phone, and OpenOrc Cloud starts no thread under another.
 */
function startUnder(thread: ThreadSummary): ThreadAction[] {
  if (thread.teamInstanceId || thread.orclingId || placeOf(thread).elsewhere) return [];
  return [{ kind: "screen", label: "New Subthread", icon: "square.and.pencil", pathname: "/new-subthread" }];
}

/** A thread's family in its header: a new subthread, the thread it came from, and the subthreads it has. */
function family(thread: ThreadSummary, panels: ThreadPanels): ThreadAction[] {
  return [
    ...startUnder(thread),
    ...(thread.parentThreadId ? [{ kind: "parent", label: "Open Parent Thread", icon: "arrow.turn.up.left", threadId: thread.parentThreadId } as const] : []),
    ...(panels.subthreads ? [{ kind: "screen", label: "Subthreads", icon: "arrow.triangle.branch", subtitle: String(panels.subthreads), pathname: "/subthreads" } as const] : []),
  ];
}

type Swipe = { label: string; patch: OrganizePatch };

/** A Home row's two swipes, as Mail's: leading marks read or unread, trailing resolves or reopens (not a team's thread). */
export function threadSwipes(thread: ThreadSummary, now = Date.now()): { leading: Swipe; trailing: Swipe | null } {
  const leading: Swipe = thread.unread ? { label: "Read", patch: { seen: true } } : { label: "Unread", patch: { seen: false } };
  if (thread.teamInstanceId || isSubagentThread(thread)) return { leading, trailing: null };
  return { leading, trailing: threadResolved(thread, now) ? { label: "Reopen", patch: { archived: false } } : { label: "Resolve", patch: { archived: true } } };
}
