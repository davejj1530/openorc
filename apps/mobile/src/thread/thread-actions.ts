import { snoozePresets } from "@openorc/client";
import type { RpcParams, ThreadSummary } from "@openorc/protocol";
import type { Link } from "expo-router";
import type { ComponentProps } from "react";

/** The changes a phone may make to how a thread is organized. */
export type OrganizePatch = Pick<RpcParams<"threads.update">["patch"], "pinned" | "archived" | "snoozedUntil" | "seen">;

type Symbol = NonNullable<ComponentProps<typeof Link.MenuAction>["icon"]>;

/**
 * One item of a thread's menu: a change to save, a snooze (its time counted when it is chosen, as a row keeps its menu
 * for hours), a submenu of them, a rename, or the thread's pull request.
 */
export type ThreadAction =
  | { kind: "patch"; label: string; icon: Symbol; patch: OrganizePatch }
  | { kind: "snooze"; label: string; icon: Symbol; until: (chosenAt: Date) => number }
  | { kind: "menu"; label: string; icon: Symbol; actions: ThreadAction[] }
  | { kind: "rename"; label: string; icon: Symbol }
  | { kind: "open"; label: string; icon: Symbol; url: string };

/** Where the menu opens: a Home row (long press), or the open thread's header, where Rename leads. */
export type MenuPlace = "row" | "header";

function snooze(thread: ThreadSummary, now: Date): ThreadAction {
  const presets = snoozePresets(now).map((preset): ThreadAction => ({ kind: "snooze", label: preset.label, icon: "clock", until: preset.until }));
  const snoozed = Boolean(thread.snoozedUntil && thread.snoozedUntil > now.getTime());
  const wake: ThreadAction[] = snoozed ? [{ kind: "patch", label: "Wake Now", icon: "sun.max", patch: { snoozedUntil: null } }] : [];
  return { kind: "menu", label: snoozed ? "Snoozed" : "Snooze", icon: "moon.zzz", actions: [...presets, ...wake] };
}

/**
 * What a paired phone may do to a thread, in the desktop menu's order and sections: pin, snooze, read state; rename and
 * the pull request; archive. A team thread's lifecycle (snooze, archive) stays with the team on the Mac. Deleting,
 * forking and moving stay on the Mac.
 */
export function threadMenu(thread: ThreadSummary, place: MenuPlace, now: Date): ThreadAction[][] {
  const team = Boolean(thread.teamInstanceId);
  const rename: ThreadAction = { kind: "rename", label: "Rename…", icon: "pencil" };
  const organize: ThreadAction[] = [
    thread.pinnedAt ? { kind: "patch", label: "Unpin", icon: "pin.slash", patch: { pinned: false } } : { kind: "patch", label: "Pin", icon: "pin", patch: { pinned: true } },
    ...(team ? [] : [snooze(thread, now)]),
    thread.unread ? { kind: "patch", label: "Mark as Read", icon: "envelope.open", patch: { seen: true } } : { kind: "patch", label: "Mark as Unread", icon: "envelope.badge", patch: { seen: false } },
  ];
  const pull: ThreadAction[] = thread.prUrl ? [{ kind: "open", label: "Open Pull Request", icon: "arrow.up.right.square", url: thread.prUrl }] : [];
  const archive: ThreadAction[] = team
    ? []
    : [
        thread.archivedAt
          ? { kind: "patch", label: "Unarchive", icon: "tray.and.arrow.up", patch: { archived: false } }
          : { kind: "patch", label: "Archive", icon: "archivebox", patch: { archived: true } },
      ];
  const sections = place === "header" ? [[rename], organize, [...pull], archive] : [organize, [rename, ...pull], archive];
  return sections.filter((section) => section.length > 0);
}

type Swipe = { label: string; patch: OrganizePatch };

/** A Home row's two swipes, as Mail's: leading marks read or unread, trailing archives (not a team's thread). */
export function threadSwipes(thread: ThreadSummary): { leading: Swipe; trailing: Swipe | null } {
  const leading: Swipe = thread.unread ? { label: "Read", patch: { seen: true } } : { label: "Unread", patch: { seen: false } };
  if (thread.teamInstanceId) return { leading, trailing: null };
  return { leading, trailing: thread.archivedAt ? { label: "Unarchive", patch: { archived: false } } : { label: "Archive", patch: { archived: true } } };
}
