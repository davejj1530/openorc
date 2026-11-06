import { isSubagentThread, type ThreadSummary } from "@openorc/protocol";
import { sidebarFoldKey, sidebarSectionOpen, type ThreadPage } from "./sidebar-thread-groups.js";
import { threadTreeActivity, threadTreeMatches, threadTreeRoot } from "./thread-tree.js";

/** When a thread last saw work, as the sidebar groups it: the last few hours, then by calendar day. Recent and Today start open. */
export type SidebarDay = "recent" | "today" | "yesterday";

/** Where a thread's latest work files it: one of the days, or Resolved once that work is from before yesterday. */
export type SidebarPlace = SidebarDay | "resolved";

/** How far back Recent reaches. Work in the last hours stays together on top, whatever day it fell on. */
export const RECENT_MS = 3 * 60 * 60 * 1000;

export const SIDEBAR_DAYS: readonly { day: SidebarDay; label: string }[] = [
  { day: "recent", label: "Recent" },
  { day: "today", label: "Today" },
  { day: "yesterday", label: "Yesterday" },
];

const OPEN_AT_FIRST: ReadonlySet<SidebarDay> = new Set(["recent", "today"]);

function startOfDay(now: number, daysAgo: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.getTime();
}

/** The place for a time: the last three hours, then by local calendar day: today, yesterday, and before that resolved. */
export function sidebarPlace(at: number, now: number): SidebarPlace {
  if (at >= now - RECENT_MS) return "recent";
  if (at >= startOfDay(now, 0)) return "today";
  if (at >= startOfDay(now, 1)) return "yesterday";
  return "resolved";
}

/** Where a root and its family go: by the latest work anywhere in it. */
function rootPlace(root: ThreadSummary, all: readonly ThreadSummary[], now: number): SidebarPlace {
  return sidebarPlace(threadTreeActivity(root, all), now);
}

/**
 * Whether a thread is in Resolved: put there, or quiet since before yesterday and neither pinned nor snoozed, which keep
 * their own parts. A started thread goes with its parent unless put there itself.
 */
export function threadResolved(thread: ThreadSummary, now: number): boolean {
  if (thread.archivedAt) return true;
  if (thread.parentThreadId || thread.pinnedAt || (thread.snoozedUntil && thread.snoozedUntil > now)) return false;
  return sidebarPlace(thread.treeActivityAt ?? thread.lastActivityAt, now) === "resolved";
}

/** The saved key of a day's fold. Days that start open save their folding; days that start folded save their opening. */
export function sidebarDayKey(day: SidebarDay): string {
  return OPEN_AT_FIRST.has(day) ? `day-closed:${day}` : `day-open:${day}`;
}

export function sidebarDayOpen(collapsed: readonly string[], day: SidebarDay): boolean {
  return collapsed.includes(sidebarDayKey(day)) !== OPEN_AT_FIRST.has(day);
}

/** The one list's name in the saved keys of its Pinned, Snoozed and Resolved folds. */
export const SIDEBAR_LIST = "threads";

const LIST_FOLDS: ReadonlySet<string> = new Set([
  ...SIDEBAR_DAYS.map(({ day }) => sidebarDayKey(day)),
  sidebarFoldKey.pinned(SIDEBAR_LIST),
  sidebarFoldKey.snoozed(SIDEBAR_LIST),
  sidebarFoldKey.resolved(SIDEBAR_LIST),
]);

/**
 * Whether a saved fold still names a part of the list: a sub thread tree, a day, or the list's Pinned, Snoozed or
 * Resolved. A day's fold that went back to its start, since the day now starts that way, says nothing more.
 */
export function liveSidebarFold(key: string): boolean {
  return /^thread-(open|closed):/.test(key) || LIST_FOLDS.has(key);
}

export type SidebarDaySection = { day: SidebarDay; label: string; roots: ThreadSummary[] };

/** Roots in their day groups, keeping their order. A tree counts as active when any thread in it last worked; resolved ones are left out. */
export function sidebarDaySections(roots: readonly ThreadSummary[], all: readonly ThreadSummary[], now: number): SidebarDaySection[] {
  const byPlace = new Map<SidebarPlace, ThreadSummary[]>();
  for (const root of roots) {
    const place = rootPlace(root, all, now);
    byPlace.set(place, [...(byPlace.get(place) ?? []), root]);
  }
  return SIDEBAR_DAYS.filter(({ day }) => byPlace.has(day)).map(({ day, label }) => ({ day, label, roots: byPlace.get(day) ?? [] }));
}

/** How many threads the list reads by itself to complete an open day; past it the reader asks. */
const GROWTH_LIMIT = 400;

/**
 * Whether the list reads its next page by itself: while the place the loaded threads end in is an open day, so an open
 * day is never cut short, or while Resolved is open with none of the list's quiet threads loaded yet. Inside Resolved
 * the reader asks for more.
 */
export function sidebarListGrows({ end, hasMore, collapsed, limit = 0 }: { end: SidebarPlace | null; hasMore: boolean; collapsed: readonly string[]; limit?: number }): boolean {
  if (!hasMore || limit >= GROWTH_LIMIT || end === "resolved") return false;
  return !end || sidebarDayOpen(collapsed, end) || sidebarSectionOpen(collapsed, "resolved", SIDEBAR_LIST);
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
 * Resolved's roots, newest work first: the ones put there, from their own read, and the list's own threads quiet since
 * before yesterday. Each read is whole only down to its last loaded root, so the merge stops at the newer of those
 * edges while either read has more; the open thread's tree always stays.
 */
function resolvedRoots(
  { quiet, put, pagesHaveMore, lastPaged }: { quiet: ThreadSummary[]; put: ThreadPage | undefined; pagesHaveMore: boolean; lastPaged: ThreadSummary | undefined },
  all: readonly ThreadSummary[],
  holdsActive: (root: ThreadSummary) => boolean,
) {
  const activity = (root: ThreadSummary | undefined) => (root ? threadTreeActivity(root, all) : -Infinity);
  const edge = Math.max(pagesHaveMore ? activity(lastPaged) : -Infinity, put?.hasMore ? activity(put.rest.at(-1)) : -Infinity);
  const roots = unique([...quiet, ...(put?.rest ?? [])])
    .filter((root) => activity(root) >= edge || holdsActive(root))
    .sort((a, b) => activity(b) - activity(a) || b.id.localeCompare(a.id));
  return { roots, hasMore: pagesHaveMore || Boolean(put?.hasMore) };
}

/**
 * What Resolved's page is made of: its read while it is open; folded, none of it but the open thread, when that one was
 * put there, so the list never hides where you are.
 */
export function resolvedRows(open: boolean, read: ThreadSummary[] | undefined, selected: ThreadSummary | null | undefined): ThreadSummary[] | undefined {
  if (open && read) return read;
  return selected?.archivedAt ? [] : undefined;
}

/**
 * The list's parts from the pages it read: pins first (under the pinned filter, every pin), then the rest in their
 * days, snoozed threads apart, and Resolved at the foot. `pins` is the read of every pin, so an old pin still leads,
 * `needsYou` the read of threads that need you, so one past the loaded pages still shows in its folded day, and
 * `resolved` the read of threads put in Resolved. `shown` keeps a folded part's rows down to the open thread's tree, so
 * the list never hides where you are; `shownInDay` keeps a folded day's trees that need you too. `end` is the place the
 * loaded pages reach, which decides whether the list reads on.
 */
export function sidebarDayList({
  pages,
  pins,
  needsYou,
  resolved,
  pinnedOnly,
  activeId,
  now,
}: {
  pages: readonly ThreadPage[];
  pins?: ThreadPage;
  needsYou?: ThreadPage;
  resolved?: ThreadPage;
  pinnedOnly: boolean;
  activeId: string | null | undefined;
  now: number;
}) {
  const hasMore = pages.some((page) => page.hasMore);
  const put = pinnedOnly ? undefined : resolved;
  const loaded = unique([...(pins?.list ?? []), ...pages.flatMap((page) => page.list)]);
  const beyond = pinnedOnly ? { roots: [], rows: [] } : beyondPages(needsYou, new Set(loaded.map((thread) => thread.id)));
  const all = unique([...loaded, ...beyond.rows, ...(put?.list ?? [])]);
  const latestFirst = (a: ThreadSummary, b: ThreadSummary) => threadTreeActivity(b, all) - threadTreeActivity(a, all) || b.id.localeCompare(a.id);
  const pinned = unique([...(pins?.pinned ?? []), ...pages.flatMap((page) => page.pinned)]).sort(latestFirst);
  const unpinned = (thread: ThreadSummary) => !pinned.some((pin) => pin.id === thread.id);
  const paged = pinnedOnly ? [] : pages.flatMap((page) => page.rest.filter(unpinned)).sort(latestFirst);
  const unfiled = [...paged, ...beyond.roots].sort(latestFirst);
  const quiet = unfiled.filter((root) => rootPlace(root, all, now) === "resolved");
  const rest = unfiled.filter((root) => !quiet.includes(root));
  const snoozed = pinnedOnly ? [] : pages.flatMap((page) => page.snoozed).sort(latestFirst);
  const holdsActive = (root: ThreadSummary) => Boolean(activeId) && threadTreeMatches(root, all, (row) => row.id === activeId);
  const last = paged.at(-1);
  return {
    all,
    hasMore,
    pinned,
    rest,
    snoozed,
    resolved: pinnedOnly ? { roots: [], hasMore: false } : resolvedRoots({ quiet, put, pagesHaveMore: hasMore, lastPaged: last }, all, holdsActive),
    end: last ? rootPlace(last, all, now) : null,
    sections: sidebarDaySections(rest, all, now),
    shown: (roots: readonly ThreadSummary[], open: boolean) => (open ? [...roots] : roots.filter(holdsActive)),
    shownInDay: (roots: readonly ThreadSummary[], open: boolean) => (open ? [...roots] : roots.filter((root) => holdsActive(root) || threadTreeMatches(root, all, threadNeedsYou))),
  };
}

export type SidebarDayList = ReturnType<typeof sidebarDayList>;
