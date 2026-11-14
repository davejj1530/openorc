import type { ThreadSummary } from "@openorc/protocol";
import { threadStatus, threadTreeStatus, type ThreadStatus } from "./thread-row.js";
import { subthreadStatuses } from "./thread-tree.js";

/** How many of its most recently active threads a project shows besides those that are not quiet, before "Show N more". */
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

/** Pinned threads in the order they were pinned, so a pin never moves for its work. */
export function pinOrder(pins: readonly ThreadSummary[]): ThreadSummary[] {
  return [...pins].sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || a.id.localeCompare(b.id));
}

/**
 * The rows each project shows, in their order, and the projects' order as the day found it, a project added since on
 * top, so work in one never moves it past another. While the list is held the rows keep their places.
 */
export type ListLayout = { day: number; projects: readonly string[]; rows: ReadonlyMap<string, readonly string[]> };

type LayoutInput = {
  /** Each project's roots, the most recently active first, as the day's list orders them. */
  groups: readonly { project: { id: string }; roots: readonly ThreadSummary[] }[];
  /** Whether a root is quiet: nothing under way, nothing to answer or read, no command left running. */
  quiet: (root: ThreadSummary) => boolean;
  now: number;
  /** The pointer or the keyboard is in the list: no row arrives, leaves or moves but by the person's hand. */
  held: boolean;
  /** Roots the person reached for: the open thread's, and those "Show N more" opened. They show at once. */
  own: readonly string[];
};

function startOfDay(now: number): number {
  return new Date(now).setHours(0, 0, 0, 0);
}

/** A project's rows as its work stands: its four most recently active roots, every root that is not quiet, and those the person reached for. */
function liveRows(roots: readonly ThreadSummary[], quiet: (root: ThreadSummary) => boolean, own: ReadonlySet<string>): string[] {
  return roots.filter((root, index) => index < GROUP_PAGE || !quiet(root) || own.has(root.id)).map((root) => root.id);
}

/** The rows a held list keeps: where they were, less a thread gone from the project, then what the person reached for. */
function heldRows(kept: readonly string[], roots: readonly ThreadSummary[], own: ReadonlySet<string>): string[] {
  const present = new Set(roots.map((root) => root.id));
  const stay = kept.filter((id) => present.has(id));
  return [...stay, ...roots.filter((root) => own.has(root.id) && !stay.includes(root.id)).map((root) => root.id)];
}

/** The list's layout after its threads changed. `prev` is null before the first settled read. */
export function listLayout(prev: ListLayout | null, { groups, quiet, now, held, own }: LayoutInput): ListLayout {
  const reached = new Set(own);
  const rows = new Map(groups.map(({ project, roots }) => [project.id, prev && held ? heldRows(prev.rows.get(project.id) ?? [], roots, reached) : liveRows(roots, quiet, reached)]));
  if (prev && held) return { ...prev, rows };
  const day = startOfDay(now);
  const known = prev?.day === day ? prev.projects : null;
  const added = groups.map((group) => group.project.id).filter((id) => !known?.includes(id));
  return { day, rows, projects: [...added, ...(known ?? [])] };
}

/** The groups in the order the day keeps; one the day has not seen yet leads. */
export function inListOrder<T extends { project: { id: string } }>(groups: readonly T[], layout: ListLayout): T[] {
  const place = (group: T) => layout.projects.indexOf(group.project.id);
  return [...groups].sort((a, b) => place(a) - place(b));
}

/**
 * What a project lists: folded, only the tree that holds the open thread, so the list never hides where you are; open,
 * its rows in the layout's order. `hidden` is what "Show N more" reaches.
 */
export function projectRows(roots: readonly ThreadSummary[], { rows, open, holdsActive }: { rows: readonly string[]; open: boolean; holdsActive: (root: ThreadSummary) => boolean }) {
  if (!open) return { rows: roots.filter(holdsActive), hidden: 0 };
  const byId = new Map(roots.map((root) => [root.id, root]));
  const shown = rows.flatMap((id) => byId.get(id) ?? []);
  return { rows: shown, hidden: roots.length - shown.length };
}

/** The roots one press on "Show N more" adds: the most recently active of those without a row. */
export function moreRows(roots: readonly ThreadSummary[], rows: readonly string[]): string[] {
  return roots
    .filter((root) => !rows.includes(root.id))
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
