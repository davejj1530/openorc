import type { ThreadSummary } from "@openorc/protocol";
import { sidebarFoldKey } from "./sidebar-thread-groups.js";
import { threadTreeActivity } from "./thread-tree.js";

/** When a thread last saw work, as the sidebar groups it. The last two start folded and open on demand. */
export type SidebarDay = "today" | "yesterday" | "week" | "older";

export const SIDEBAR_DAYS: readonly { day: SidebarDay; label: string }[] = [
  { day: "today", label: "Today" },
  { day: "yesterday", label: "Yesterday" },
  { day: "week", label: "Last 7 days" },
  { day: "older", label: "Older" },
];

const OPEN_AT_FIRST: ReadonlySet<SidebarDay> = new Set(["today", "yesterday"]);

function startOfDay(now: number, daysAgo: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

/** The day group for a time, by local calendar days: today, yesterday, the five days before, then older. */
export function sidebarDay(at: number, now: number): SidebarDay {
  if (at >= startOfDay(now, 0)) return "today";
  if (at >= startOfDay(now, 1)) return "yesterday";
  if (at >= startOfDay(now, 6)) return "week";
  return "older";
}

/** The saved key of a day's fold. Days that start open save their folding; days that start folded save their opening. */
export function sidebarDayKey(day: SidebarDay): string {
  return OPEN_AT_FIRST.has(day) ? `day-closed:${day}` : `day-open:${day}`;
}

export function sidebarDayOpen(collapsed: readonly string[], day: SidebarDay): boolean {
  return collapsed.includes(sidebarDayKey(day)) !== OPEN_AT_FIRST.has(day);
}

/** The one list's name in the saved keys of its Pinned and Snoozed folds. */
export const SIDEBAR_LIST = "threads";

/** Whether a saved fold still names a part of the list: a sub thread tree, a day, or the list's Pinned or Snoozed. */
export function liveSidebarFold(key: string): boolean {
  return /^(thread|day)-(open|closed):/.test(key) || key === sidebarFoldKey.pinned(SIDEBAR_LIST) || key === sidebarFoldKey.snoozed(SIDEBAR_LIST);
}

export type SidebarDaySection = { day: SidebarDay; label: string; roots: ThreadSummary[] };

/**
 * Roots in their day groups, keeping their order. A tree counts as active when any thread in it last worked. Older
 * also stands while more threads are left to load, since they can only be older than the loaded ones.
 */
export function sidebarDaySections(roots: readonly ThreadSummary[], all: readonly ThreadSummary[], now: number, hasMore = false): SidebarDaySection[] {
  const byDay = new Map<SidebarDay, ThreadSummary[]>();
  for (const root of roots) {
    const day = sidebarDay(threadTreeActivity(root, all), now);
    byDay.set(day, [...(byDay.get(day) ?? []), root]);
  }
  return SIDEBAR_DAYS.filter(({ day }) => byDay.has(day) || (day === "older" && hasMore)).map(({ day, label }) => ({ day, label, roots: byDay.get(day) ?? [] }));
}

/**
 * Whether the list reads its next page by itself: while the day the loaded threads end in is open, so an open day is
 * never cut short, or while Older is open with nothing of it loaded yet. Inside Older the reader asks for more.
 */
export function sidebarListGrows({ sections, hasMore, collapsed }: { sections: readonly SidebarDaySection[]; hasMore: boolean; collapsed: readonly string[] }): boolean {
  if (!hasMore) return false;
  const last = sections.findLast((section) => section.roots.length)?.day;
  if (last === "older") return false;
  return !last || sidebarDayOpen(collapsed, last) || sidebarDayOpen(collapsed, "older");
}
