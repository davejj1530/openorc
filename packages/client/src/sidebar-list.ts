import type { ThreadSummary } from "@openorc/protocol";
import { threadStatus, threadTreeStatus, type ThreadStatus } from "./thread-row.js";
import { subthreadStatuses } from "./thread-tree.js";

/** How many rows a project opens the day with, its threads that are not quiet first, before "Show N more". */
export const GROUP_PAGE = 4;

/** How many more each "Show N more" adds. */
export const GROUP_STEP = 10;

/** What a root's row says for its whole tree, or null when the thread is quiet. */
export function rootStatuses(roots: readonly ThreadSummary[], all: readonly ThreadSummary[]): Map<string, ThreadStatus | null> {
  const below = subthreadStatuses(all);
  return new Map(roots.map((root) => [root.id, threadTreeStatus(threadStatus(root), below.get(root.id) ?? null)]));
}

const CALLS: ReadonlySet<ThreadStatus["kind"]> = new Set(["waiting", "failed", "unread"]);

/** A question, a failure or a result not yet read: what the line at the list's edge names. Work under way calls no one. */
export function callsThePerson(status: ThreadStatus | null | undefined): boolean {
  return Boolean(status && CALLS.has(status.kind));
}

/** A project's roots in the order the list keeps: the newest started on top. A change of state never moves one. */
export function startedFirst(roots: readonly ThreadSummary[]): ThreadSummary[] {
  return [...roots].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Pinned threads in the order they were pinned, so a pin never moves for its work. */
export function pinOrder(pins: readonly ThreadSummary[]): ThreadSummary[] {
  return [...pins].sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Which roots have a row, remembered through the day. A project opens with every root that is not quiet and its newest
 * quiet ones, four rows in all; after that rows only join (a root that starts, wakes, or the person asks for) and none
 * leaves until the next day. `since` is when the day's page was made. `projects` is the projects' order as the day
 * found it, a project added since on top, so work in one never moves it past another.
 */
export type ListMembers = { day: number; since: number; ids: ReadonlySet<string>; projects: readonly string[] };

type MembersInput = {
  groups: readonly { project: { id: string }; roots: readonly ThreadSummary[] }[];
  /** Whether a root is quiet: nothing under way, nothing to answer or read, no command left running. */
  quiet: (root: ThreadSummary) => boolean;
  now: number;
  /** The pointer or the keyboard is in the list: nothing arrives or leaves but what the person did. */
  held: boolean;
  /** Roots the person reached for: the open thread's, and those "Show N more" opened. They join at once. */
  own: readonly string[];
};

function startOfDay(now: number): number {
  return new Date(now).setHours(0, 0, 0, 0);
}

/** A project's first page: every root that is not quiet, then the newest quiet ones up to four rows. */
function firstPage(roots: readonly ThreadSummary[], quiet: (root: ThreadSummary) => boolean): ThreadSummary[] {
  const live = roots.filter((root) => !quiet(root));
  return [...live, ...roots.filter(quiet).slice(0, Math.max(0, GROUP_PAGE - live.length))];
}

/** The rows after the list's threads changed. `prev` is null before the first settled read. */
export function listMembers(prev: ListMembers | null, { groups, quiet, now, held, own }: MembersInput): ListMembers {
  if (prev && held) return own.every((id) => prev.ids.has(id)) ? prev : { ...prev, ids: new Set([...prev.ids, ...own]) };
  const day = startOfDay(now);
  const kept = prev?.day === day ? prev : null;
  const since = kept?.since ?? now;
  const ids = new Set([...(kept?.ids ?? []), ...own]);
  for (const { project, roots } of groups) {
    const ordered = startedFirst(roots);
    const joining = kept?.projects.includes(project.id) ? ordered.filter((root) => !quiet(root) || root.createdAt >= since) : firstPage(ordered, quiet);
    for (const root of joining) ids.add(root.id);
  }
  const known = kept?.projects ?? [];
  const added = groups.map((group) => group.project.id).filter((id) => !known.includes(id));
  return { day, since, ids, projects: kept ? [...added, ...known] : added };
}

/** The groups in the order the day keeps; one the day has not seen yet leads. */
export function inListOrder<T extends { project: { id: string } }>(groups: readonly T[], members: ListMembers): T[] {
  const place = (group: T) => members.projects.indexOf(group.project.id);
  return [...groups].sort((a, b) => place(a) - place(b));
}

/**
 * What a project lists: folded, only the tree that holds the open thread, so the list never hides where you are; open,
 * its rows in their kept order. `hidden` is what "Show N more" reaches.
 */
export function projectRows(roots: readonly ThreadSummary[], { members, open, holdsActive }: { members: ReadonlySet<string>; open: boolean; holdsActive: (root: ThreadSummary) => boolean }) {
  const ordered = startedFirst(roots);
  if (!open) return { rows: ordered.filter(holdsActive), hidden: 0 };
  const rows = ordered.filter((root) => members.has(root.id) || holdsActive(root));
  return { rows, hidden: ordered.length - rows.length };
}

/** The roots one press on "Show N more" adds: the newest of those without a row. */
export function moreRows(roots: readonly ThreadSummary[], members: ReadonlySet<string>): string[] {
  return startedFirst(roots)
    .filter((root) => !members.has(root.id))
    .slice(0, GROUP_STEP)
    .map((root) => root.id);
}

/** Where something that calls the person sits in the scrolling list, in the list's own coordinates. */
export type EdgeTarget = { id: string; top: number; bottom: number };

/** What is past each edge of the list's view, in the list's order. */
export type ListEdges = { above: string[]; below: string[] };

/**
 * What calls the person and is not whole in view, by the edge it is past. A line at an edge covers `line` px of the view,
 * so a row under it counts as past that edge too.
 */
export function pastEdges(targets: readonly EdgeTarget[], view: { top: number; bottom: number }, line: number): ListEdges {
  let edges: ListEdges = { above: [], below: [] };
  // Each line that appears only narrows the view, so this settles within a pass per edge.
  for (let pass = 0; pass < 3; pass += 1) {
    const top = view.top + (edges.above.length ? line : 0);
    const bottom = view.bottom - (edges.below.length ? line : 0);
    const next = { above: targets.filter((t) => t.top < top).map((t) => t.id), below: targets.filter((t) => t.top >= top && t.bottom > bottom).map((t) => t.id) };
    if (next.above.length === edges.above.length && next.below.length === edges.below.length) return next;
    edges = next;
  }
  return edges;
}

/** The one a press on an edge's line brings into view: the nearest past that edge. */
export function nearestPast(edges: ListEdges, edge: keyof ListEdges): string | undefined {
  return edge === "above" ? edges.above.at(-1) : edges.below[0];
}

/**
 * Where the list scrolls to put a target whole in view, clear of a line that may stay at either edge. Close to the top
 * it goes to the top, so the first project's label shows.
 */
export function scrollToBring(target: EdgeTarget, view: { top: number; height: number }, line: number): number {
  const gap = 8;
  if (target.top < view.top + line) {
    const to = target.top - line - gap;
    return to < line * 2 ? 0 : to;
  }
  return Math.max(view.top, target.bottom + line + gap - view.height);
}

/** The words of an edge's line: the thread's title when one is past it, else how many. */
export function edgeWords(past: readonly string[], titleOf: (id: string) => string): string {
  return past.length === 1 ? titleOf(past[0]!) : `${past.length} need you`;
}
