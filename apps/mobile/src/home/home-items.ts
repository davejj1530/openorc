import {
  listLayout,
  projectRows,
  rootStatuses,
  SIDEBAR_LIST,
  sidebarFoldKey,
  sidebarSectionOpen,
  threadTreeRows,
  waitingRoots,
  type ListLayout,
  type SidebarDayList,
  type ThreadTreeRow,
} from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

/** A project as its group heads Home's list: the key every id of it maps to, its name, and whether only OpenOrc Cloud has it. */
export type HomeProject = { id: string; name: string; cloud?: true };

/** What Home read from a host: its threads as the sidebar lists them, and every project's name. */
export interface HomeList {
  /** Pins, the rest, snoozed threads and Resolved, as the desktop's sidebar reads them. */
  days: SidebarDayList;
  /** Every project's name by id, Workspace's included. */
  names: ReadonlyMap<string, string>;
  /** The projects Home groups threads by, in the space's order, less the workspaces the person hid. */
  groups: readonly HomeProject[];
  /** The group key of every id a thread may carry for its project; a project of this Mac is its own key. */
  groupOf: ReadonlyMap<string, string>;
  /** The host could not list its threads. */
  failed: boolean;
  /** The host answered with its list, so Resolved has a place to stand. */
  listed: boolean;
  /** How many threads Resolved holds, once the host has said; an older Mac never does. */
  resolvedCount?: number;
}

/** A part of the list that folds under its label: Pinned, Snoozed or Resolved. */
export type HomePart = "pinned" | "snoozed" | "resolved";

/** One row of Home's list. Labels and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /** Pinned, Snoozed or Resolved's label. `count` where it is the part's whole. */
  | { kind: "section"; key: string; part: HomePart; label: string; count?: number; open: boolean }
  /** A project's label over its threads, with how many of them wait on the person. */
  | { kind: "project"; key: string; project: HomeProject; open: boolean; waiting: number }
  /**
   * `project` is the name a root row shows, outside its project's group; rows in their group, and sub threads, show
   * none. `arriving` rises it in.
   */
  | { kind: "thread"; key: string; thread: ThreadSummary; tree: ThreadTreeRow; project: string | null; arriving: boolean }
  /** The foot of Resolved (or of Pinned, under the pinned filter) while the host has more threads to give. */
  | { kind: "more"; key: string }
  /** The foot of a project's group while it holds more threads than it shows. */
  | { kind: "group-more"; key: string; projectId: string; count: number }
  | { kind: "children-more"; key: string; tree: ThreadTreeRow; count: number }
  /** A list the host could not give: the projects, or the threads. */
  | { kind: "retry"; key: string; projects: boolean };

export interface HomeOptions {
  now: number;
  /** Home lists only the pinned threads. */
  pinnedOnly: boolean;
  /** The reader's saved fold keys. */
  collapsed: readonly string[];
  /** The host could not list its projects. */
  projectsFailed: boolean;
  /** The part the reader just opened, by its fold key, whose rows rise in. */
  opened: string | null;
  /** Which rows each project shows and the projects' order: `homeLayout`'s, kept from one read to the next. */
  layout: ListLayout;
  childLimits?: Readonly<Record<string, number>>;
  selectedId?: string;
}

/** What the No project group is called: the Workspace's threads, which belong to no project. */
const NO_PROJECT = "No project";

/** A project's threads' roots, the most recently active first, as the day list orders them. */
type Group = { project: HomeProject; roots: ThreadSummary[] };

/** The roots in their projects' groups, in the space's order. A root of a project the space does not name is left out. */
function groupsOf(list: HomeList): Group[] {
  const byGroup = new Map<string, ThreadSummary[]>(list.groups.map((project) => [project.id, []]));
  for (const root of list.days.rest) byGroup.get(list.groupOf.get(root.projectId) ?? root.projectId)?.push(root);
  return list.groups.map((project) => ({ project, roots: byGroup.get(project.id) ?? [] }));
}

/** The open thread's tree among the roots, which a folded group still shows, as the sidebar keeps where you are. */
const holding = (list: HomeList) => new Set(list.days.shown(list.days.rest, false).map((root) => root.id));

/**
 * Which rows each project shows and the order of the projects, as the desktop's sidebar keeps them: a project's four
 * most recently active threads and every one that is not quiet, plus those `reached` by "Show N more" and the open
 * thread's; the projects in the order the day first found them, one added since on top. `previous` is the layout of the
 * last read, null at first.
 */
export function homeLayout(list: HomeList, { now, reached }: { now: number; reached: readonly string[] }, previous: ListLayout | null): ListLayout {
  const statuses = rootStatuses(list.days.rest, list.days.all);
  return listLayout(previous, { groups: groupsOf(list), quiet: (root) => !statuses.get(root.id), now, held: false, own: [...reached, ...holding(list)] });
}

/** Rows for some roots and their trees, each parent's next page of sub threads at the foot of its tree. */
function treeRows(roots: readonly ThreadSummary[], list: HomeList, options: HomeOptions, { named, arriving }: { named: boolean; arriving: boolean }): HomeItem[] {
  const trees = threadTreeRows(roots, list.days.all, options.collapsed, options.selectedId ? [options.selectedId] : [], options.childLimits);
  const items: HomeItem[] = [];
  const pages: ThreadTreeRow[] = [];
  const end = () => {
    const tree = pages.pop()!;
    items.push({ kind: "children-more", key: `children-more:${tree.thread.id}`, tree, count: tree.hiddenChildren! });
  };
  for (const tree of trees) {
    while (pages.length && pages.at(-1)!.depth >= tree.depth) end();
    const project = named && !tree.depth ? (list.names.get(tree.thread.projectId) ?? null) : null;
    items.push({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project, arriving });
    if (tree.expanded && tree.hiddenChildren) pages.push(tree);
  }
  while (pages.length) end();
  return items;
}

/** One part that folds: its label, then its rows while open (a folded one keeps the open thread), then its paging. */
interface Part {
  part: HomePart;
  label: string;
  roots: readonly ThreadSummary[];
  /** Shows how many roots it holds: Pinned and Snoozed, whose rows are all loaded. */
  counted?: boolean;
  more?: boolean;
  /** Resolved stands with none of it loaded, since it reads its threads once opened. */
  standsEmpty?: boolean;
}

function partItems({ part, label, roots, counted, more, standsEmpty }: Part, list: HomeList, options: HomeOptions): HomeItem[] {
  if (!roots.length && !standsEmpty) return [];
  const key = sidebarFoldKey[part](SIDEBAR_LIST);
  const open = sidebarSectionOpen(options.collapsed, part, SIDEBAR_LIST);
  return [
    { kind: "section", key, part, label, open, ...(counted ? { count: roots.length } : {}) },
    ...treeRows(list.days.shown(roots, open), list, options, { named: true, arriving: options.opened === key }),
    ...(open && more ? [{ kind: "more", key: `more:${key}` } as const] : []),
  ];
}

/**
 * Each project's group in the layout's order: its label with what waits on the person counted, then its rows, then
 * "Show N more". A group with nothing in it stands only when it is the only project's.
 */
function groupItems(list: HomeList, options: HomeOptions): HomeItem[] {
  // No project stands only while it holds threads, as on the Mac's sidebar.
  const all = groupsOf(list).filter((group) => group.project.id !== WORKSPACE_ID || group.roots.length);
  const groups = all.length === 1 ? all : all.filter((group) => group.roots.length);
  const place = (group: Group) => options.layout.projects.indexOf(group.project.id);
  const active = holding(list);
  return [...groups]
    .sort((a, b) => place(a) - place(b))
    .flatMap(({ project, roots }) => {
      const key = sidebarFoldKey.project(project.id);
      const open = sidebarSectionOpen(options.collapsed, "project", project.id);
      const shown = projectRows(roots, { rows: options.layout.rows.get(project.id) ?? [], open, holdsActive: (root) => active.has(root.id) });
      const label = project.id === WORKSPACE_ID ? { ...project, name: NO_PROJECT } : project;
      return [
        { kind: "project", key, project: label, open, waiting: waitingRoots(roots, list.days.all) } as const,
        ...treeRows(shown.rows, list, options, { named: false, arriving: options.opened === key }),
        ...(shown.hidden ? [{ kind: "group-more", key: `group-more:${project.id}`, projectId: project.id, count: shown.hidden } as const] : []),
      ];
    });
}

/**
 * Home, as the desktop's sidebar lists threads since its redesign: pinned threads first, then each project's group, then
 * snoozed threads and Resolved, which holds everything quiet since before yesterday, folded at the foot. Under the
 * pinned filter, the pins alone.
 */
export function homeItems(list: HomeList, options: HomeOptions): HomeItem[] {
  const { days } = list;
  return [
    ...(options.projectsFailed ? [{ kind: "retry", key: "retry:projects", projects: true } as const] : []),
    ...partItems({ part: "pinned", label: "Pinned", roots: days.pinned, counted: true, more: options.pinnedOnly && days.hasMore }, list, options),
    ...(options.pinnedOnly ? [] : groupItems(list, options)),
    ...(list.failed ? [{ kind: "retry", key: "retry:threads", projects: false } as const] : []),
    ...partItems({ part: "snoozed", label: "Snoozed", roots: days.snoozed, counted: true }, list, options),
    ...partItems(
      {
        part: "resolved",
        label: "Resolved",
        roots: days.resolved.roots,
        more: days.resolved.hasMore,
        // Not once the host says it holds nothing: an empty fold at the foot opens on nothing.
        standsEmpty: list.listed && !options.pinnedOnly && list.resolvedCount !== 0,
      },
      list,
      options,
    ),
  ];
}
