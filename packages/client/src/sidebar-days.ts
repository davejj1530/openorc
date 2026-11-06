import { isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { sidebarFoldKey, type ThreadPage } from "./sidebar-thread-groups.js";
import { threadTreeActivity, threadTreeMatches, threadTreeRoot } from "./thread-tree.js";

/** When a thread last saw work, as the sidebar groups it: the last few hours, then by calendar day. Recent and Today start open. */
export type SidebarDay = "recent" | "today" | "yesterday" | "week" | "older";

/** How far back Recent reaches. Work in the last hours stays together on top, whatever day it fell on. */
export const RECENT_MS = 3 * 60 * 60 * 1000;

export const SIDEBAR_DAYS: readonly { day: SidebarDay; label: string }[] = [
  { day: "recent", label: "Recent" },
  { day: "today", label: "Today" },
  { day: "yesterday", label: "Yesterday" },
  { day: "week", label: "Last 7 days" },
  { day: "older", label: "Older" },
];

const OPEN_AT_FIRST: ReadonlySet<SidebarDay> = new Set(["recent", "today"]);

function startOfDay(now: number, daysAgo: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

/** The group for a time: the last three hours, then by local calendar day: today, yesterday, the five days before, older. */
export function sidebarDay(at: number, now: number): SidebarDay {
  if (at >= now - RECENT_MS) return "recent";
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

const DAY_FOLDS: ReadonlySet<string> = new Set(SIDEBAR_DAYS.map(({ day }) => sidebarDayKey(day)));

/**
 * Whether a saved fold still names a part of the list: a sub thread tree, a day, or the list's Pinned or Snoozed. A day's
 * fold that went back to its start, since the day now starts that way, says nothing more.
 */
export function liveSidebarFold(key: string): boolean {
  return /^thread-(open|closed):/.test(key) || DAY_FOLDS.has(key) || key === sidebarFoldKey.pinned(SIDEBAR_LIST) || key === sidebarFoldKey.snoozed(SIDEBAR_LIST);
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

/** How many threads the list reads by itself to complete an open day; past it the reader asks. */
const GROWTH_LIMIT = 400;

/**
 * Whether the list reads its next page by itself: while the day the loaded threads end in is open, so an open day is
 * never cut short, or while Older is open with nothing of it loaded yet. Inside Older the reader asks for more.
 */
export function sidebarListGrows({ end, hasMore, collapsed, limit = 0 }: { end: SidebarDay | null; hasMore: boolean; collapsed: readonly string[]; limit?: number }): boolean {
  if (!hasMore || limit >= GROWTH_LIMIT || end === "older") return false;
  return !end || sidebarDayOpen(collapsed, end) || sidebarDayOpen(collapsed, "older");
}

/**
 * A thread that needs you: unread, waiting on you, or with an agent on it. A folded day still shows these. A subagent
 * counts only while it works: its parent reads its result, so a finished one stays unread forever.
 */
export function threadNeedsYou(thread: ThreadSummary): boolean {
  return thread.activity !== "idle" || (thread.unread && !isSubagentThread(thread));
}

/** How many threads that need you the list reads past its pages. Older hosts ignore that filter and answer with their newest threads. */
export const NEEDS_YOU_PAGE = 50;

const unique = (rows: readonly ThreadSummary[]) => [...new Map(rows.map((thread) => [thread.id, thread])).values()];

/**
 * The threads of a needs-you read that no loaded page holds, each with its tree. Only roots that need you count, since an
 * older host answers with every thread.
 */
function beyondPages(needsYou: ThreadPage | undefined, loaded: ReadonlySet<string>) {
  if (!needsYou) return { roots: [], rows: [] };
  const roots = needsYou.rest.filter((root) => !loaded.has(root.id) && threadTreeMatches(root, needsYou.list, threadNeedsYou));
  const ids = new Set(roots.map((root) => root.id));
  const byId = new Map(needsYou.list.map((thread) => [thread.id, thread]));
  return { roots, rows: needsYou.list.filter((row) => !loaded.has(row.id) && ids.has(threadTreeRoot(row, byId)?.id ?? "")) };
}

/**
 * The list's parts from the pages it read: pins first (under the pinned filter, every pin), then the rest in their
 * days, and snoozed threads apart. `pins` is the read of every pin, so an old pin still leads, and `needsYou` the read
 * of threads that need you, so one past the loaded pages still shows in its folded day. `shown` keeps a folded part's
 * rows down to the open thread's tree, so the list never hides where you are; `shownInDay` keeps a folded day's trees
 * that need you too. `end` is the day the loaded pages reach, which decides whether the list reads on.
 */
export function sidebarDayList({
  pages,
  pins,
  needsYou,
  pinnedOnly,
  activeId,
  now,
}: {
  pages: readonly ThreadPage[];
  pins?: ThreadPage;
  needsYou?: ThreadPage;
  pinnedOnly: boolean;
  activeId: string | null | undefined;
  now: number;
}) {
  const hasMore = pages.some((page) => page.hasMore);
  const loaded = unique([...(pins?.list ?? []), ...pages.flatMap((page) => page.list)]);
  const beyond = pinnedOnly ? { roots: [], rows: [] } : beyondPages(needsYou, new Set(loaded.map((thread) => thread.id)));
  const all = unique([...loaded, ...beyond.rows]);
  const latestFirst = (a: ThreadSummary, b: ThreadSummary) => threadTreeActivity(b, all) - threadTreeActivity(a, all) || b.id.localeCompare(a.id);
  const pinned = unique([...(pins?.pinned ?? []), ...pages.flatMap((page) => page.pinned)]).sort(latestFirst);
  const unpinned = (thread: ThreadSummary) => !pinned.some((pin) => pin.id === thread.id);
  const paged = pinnedOnly ? [] : pages.flatMap((page) => page.rest.filter(unpinned)).sort(latestFirst);
  const rest = [...paged, ...beyond.roots].sort(latestFirst);
  const snoozed = pinnedOnly ? [] : pages.flatMap((page) => page.snoozed).sort(latestFirst);
  const holdsActive = (root: ThreadSummary) => Boolean(activeId) && threadTreeMatches(root, all, (row) => row.id === activeId);
  const last = paged.at(-1);
  return {
    all,
    hasMore,
    pinned,
    rest,
    snoozed,
    end: last ? sidebarDay(threadTreeActivity(last, all), now) : null,
    sections: sidebarDaySections(rest, all, now, hasMore && !pinnedOnly),
    shown: (roots: readonly ThreadSummary[], open: boolean) => (open ? [...roots] : roots.filter(holdsActive)),
    shownInDay: (roots: readonly ThreadSummary[], open: boolean) => (open ? [...roots] : roots.filter((root) => holdsActive(root) || threadTreeMatches(root, all, threadNeedsYou))),
  };
}

export type SidebarDayList = ReturnType<typeof sidebarDayList>;
