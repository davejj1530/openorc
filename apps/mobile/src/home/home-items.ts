import { SIDEBAR_LIST, sidebarDayKey, sidebarDayOpen, sidebarFoldKey, sidebarSectionOpen, threadTreeRows, visibleThreadForest, type SidebarDayList, type ThreadTreeRow } from "@openorc/client";
import type { ThreadOwner, ThreadSummary } from "@openorc/protocol";

/**
 * A Mac lists its cloud brain's threads among its own, marked as the cloud's. Once the phone pairs that brain too, the
 * switch shows one host at a time, so the Mac keeps only its own threads and the brain's show when it is chosen.
 */
export function shownApartFromBrain(host: string | null, group: { primary: string | null; partner: string | null }, kinds: ReadonlyMap<string, "mac" | "brain">): boolean {
  const shown = host ?? group.primary;
  const beside = shown === group.primary ? group.partner : group.primary;
  return shown !== null && beside !== null && kinds.get(shown) !== "brain" && kinds.get(beside) === "brain";
}

/** A Mac's rows without those it relays from its cloud brain. */
export function ownRows<T extends readonly ThreadSummary[] | undefined>(rows: T, apart: boolean): T {
  return (apart && rows ? rows.filter((row) => row.owner?.brain !== "cloud") : rows) as T;
}

/** What Home read from a host: its threads as the sidebar lists them, and every project's name. */
export interface HomeList {
  /** Pins, the rest in their days, snoozed threads and Resolved, as the desktop's sidebar shows them. */
  days: SidebarDayList;
  /** Every project's name by id, Workspace's included. */
  names: ReadonlyMap<string, string>;
  /** Every thread the lists read, a page's lookahead past its end included, for Needs you. */
  read: readonly ThreadSummary[];
  /** The host could not list its threads. */
  failed: boolean;
  /** The host answered with its list, so Resolved has a place to stand. */
  listed: boolean;
  /** How many threads Resolved holds, once the host has said; an older Mac never does. */
  resolvedCount?: number;
}

/** One row of Home's list. Headings and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /** Needs you's heading: what waits on you across projects and hosts. It never folds. */
  | { kind: "heading"; key: string; title: string; count: number }
  /** A part of the list that folds under its label: Pinned, a day, Snoozed or Resolved. `count` where it is the part's whole. */
  | { kind: "section"; key: string; label: string; count?: number; open: boolean }
  /**
   * `project` is the name a root row shows under its title; sub threads show none. `arriving` rises it in.
   */
  | { kind: "thread"; key: string; thread: ThreadSummary; tree: ThreadTreeRow; project: string | null; arriving: boolean }
  /** The foot of Resolved (or of Pinned, under the pinned filter) while the host has more threads to give. */
  | { kind: "more"; key: string }
  | { kind: "children-more"; key: string; tree: ThreadTreeRow; count: number }
  /** A list the host could not give: the projects, or the threads. */
  | { kind: "retry"; key: string; projects: boolean };

export interface HomeOptions {
  now: number;
  /** Home lists only the pinned threads. */
  pinnedOnly: boolean;
  /** The reader's saved fold keys. */
  collapsed: readonly string[];
  /** Threads the host's inbox says wait on you, which may lie past the pages loaded so far. */
  waiting: readonly ThreadSummary[];
  /** The host could not list its projects. */
  projectsFailed: boolean;
  /** The part the reader just opened, by its fold key, whose rows rise in. */
  opened: string | null;
  childLimits?: Readonly<Record<string, number>>;
  selectedId?: string;
}

/** A thread waiting on you, with the project it is in. */
export interface Waiting {
  thread: ThreadSummary;
  project: string | null;
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastActivityAt - a.lastActivityAt;
const isWaiting = (thread: ThreadSummary) => thread.activity === "waiting";

/** The shown host's rows marked as another host's: as out of reach while it cannot be reached. */
export function owned(items: HomeItem[], owner: ThreadOwner): HomeItem[] {
  return items.map((item) => (item.kind === "thread" ? { ...item, thread: { ...item.thread, owner } } : item));
}

/**
 * This host's threads waiting on you, once each, newest first: from every thread the lists read and from the inbox,
 * whose reads skip what a list already read.
 */
export function homeWaiting(list: HomeList, options: HomeOptions): Waiting[] {
  const all = visibleThreadForest([...new Map([...options.waiting, ...list.read].map((thread) => [thread.id, thread])).values()], false, options.now);
  return all
    .filter((thread) => isWaiting(thread) && !thread.archivedAt && !thread.teamInstanceId)
    .sort(newestFirst)
    .map((thread) => ({ thread, project: list.names.get(thread.projectId) ?? null }));
}

/** Rows for some roots and their trees, each parent's next page of sub threads at the foot of its tree. */
function treeRows(roots: readonly ThreadSummary[], all: readonly ThreadSummary[], list: HomeList, options: HomeOptions, arriving: boolean): HomeItem[] {
  const trees = threadTreeRows(roots, all, options.collapsed, options.selectedId ? [options.selectedId] : [], options.childLimits);
  const items: HomeItem[] = [];
  const pages: ThreadTreeRow[] = [];
  const end = () => {
    const tree = pages.pop()!;
    items.push({ kind: "children-more", key: `children-more:${tree.thread.id}`, tree, count: tree.hiddenChildren! });
  };
  for (const tree of trees) {
    while (pages.length && pages.at(-1)!.depth >= tree.depth) end();
    items.push({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project: tree.depth ? null : (list.names.get(tree.thread.projectId) ?? null), arriving });
    if (tree.expanded && tree.hiddenChildren) pages.push(tree);
  }
  while (pages.length) end();
  return items;
}

/** One part that folds: its label, then its rows while open (a folded one keeps the open thread), then its paging. */
interface Part {
  key: string;
  label: string;
  roots: readonly ThreadSummary[];
  open: boolean;
  /** Shows how many roots it holds: Pinned and Snoozed, whose rows are all loaded. */
  counted?: boolean;
  /** How many it holds in all, as the host counts them: Resolved, whose rows load a page at a time. */
  total?: number;
  more?: boolean;
  /** Resolved stands with none of it loaded, since it reads its threads once opened. */
  standsEmpty?: boolean;
  /** A day, which folded still shows the threads that need you. */
  day?: boolean;
}

/** The count a part's heading shows: what it lists where that is all of it, else the host's total when there is one. */
function countOf(part: Part, roots: readonly ThreadSummary[]): { count?: number } {
  if (part.counted) return { count: roots.length };
  return part.total === undefined ? {} : { count: part.total };
}

function partItems(part: Part, list: HomeList, options: HomeOptions, waitingRoots: ReadonlySet<string>): HomeItem[] {
  const roots = part.roots.filter((thread) => !waitingRoots.has(thread.id));
  if (!roots.length && !part.standsEmpty) return [];
  const all = list.days.all.filter((thread) => !waitingRoots.has(thread.id));
  return [
    { kind: "section", key: part.key, label: part.label, open: part.open, ...countOf(part, roots) },
    ...treeRows((part.day ? list.days.shownInDay : list.days.shown)(roots, part.open), all, list, options, options.opened === part.key),
    ...(part.open && part.more ? [{ kind: "more", key: `more:${part.key}` } as const] : []),
  ];
}

/** Needs you's heading and rows, this host's waiting threads, newest first. */
function needsYouItems(waiting: readonly Waiting[]): HomeItem[] {
  if (!waiting.length) return [];
  const items: HomeItem[] = [{ kind: "heading", key: "needs-you", title: "Needs you", count: waiting.length }];
  for (const { thread, project } of waiting)
    for (const tree of threadTreeRows([thread], [thread], [])) items.push({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project: tree.depth ? null : project, arriving: false });
  return items;
}

/**
 * Home, as the desktop's sidebar lists threads: every thread waiting on you first, across projects,
 * then pinned threads, then the rest by when they last saw work (the last three hours and today open, yesterday
 * folded), then snoozed threads and Resolved, which holds everything older, folded at the foot. A waiting thread appears
 * once, under Needs you, which never folds.
 */
export function homeItems(list: HomeList, options: HomeOptions): HomeItem[] {
  const { days } = list;
  const waiting = homeWaiting(list, options);
  const waitingRoots = new Set(waiting.map(({ thread }) => thread.id));
  const pinsKey = sidebarFoldKey.pinned(SIDEBAR_LIST);
  const snoozedKey = sidebarFoldKey.snoozed(SIDEBAR_LIST);
  const resolvedKey = sidebarFoldKey.resolved(SIDEBAR_LIST);
  const parts: Part[] = [
    { key: pinsKey, label: "Pinned", roots: days.pinned, open: sidebarSectionOpen(options.collapsed, "pinned", SIDEBAR_LIST), counted: true, more: options.pinnedOnly && days.hasMore },
    ...days.sections.map(({ day, label, roots }) => ({
      key: sidebarDayKey(day),
      label,
      roots,
      open: sidebarDayOpen(options.collapsed, day),
      day: true,
    })),
  ];
  return [
    ...needsYouItems(waiting),
    ...(options.projectsFailed ? [{ kind: "retry", key: "retry:projects", projects: true } as const] : []),
    ...parts.flatMap((part) => partItems(part, list, options, waitingRoots)),
    ...(list.failed ? [{ kind: "retry", key: "retry:threads", projects: false } as const] : []),
    ...partItems({ key: snoozedKey, label: "Snoozed", roots: days.snoozed, open: sidebarSectionOpen(options.collapsed, "snoozed", SIDEBAR_LIST), counted: true }, list, options, waitingRoots),
    ...partItems(
      {
        key: resolvedKey,
        label: "Resolved",
        roots: days.resolved.roots,
        open: sidebarSectionOpen(options.collapsed, "resolved", SIDEBAR_LIST),
        more: days.resolved.hasMore,
        total: list.resolvedCount,
        // Not once the host says it holds nothing: an empty fold at the foot says only "0".
        standsEmpty: list.listed && !options.pinnedOnly && list.resolvedCount !== 0,
      },
      list,
      options,
      waitingRoots,
    ),
  ];
}
