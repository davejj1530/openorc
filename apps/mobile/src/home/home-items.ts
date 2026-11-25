import {
  callsThePerson,
  listLayout,
  projectDaySections,
  projectRows,
  rootStatuses,
  SIDEBAR_LIST,
  sidebarFoldKey,
  sidebarSectionOpen,
  threadTreeRows,
  waitingRoots,
  type ListLayout,
  type SidebarDayList,
  type ThreadStatus,
  type ThreadTreeRow,
} from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

/** A project as its group heads Home's list: the key every id of it maps to, its name, and whether only OpenOrc Cloud has it. */
export type HomeProject = { id: string; name: string; cloud?: true };

/**
 * A project's Resolved as its group ends with it: folded, only the open thread's tree when that one is resolved; open,
 * its own read of the project, a page at a time.
 */
export interface ProjectResolved {
  open: boolean;
  roots: readonly ThreadSummary[];
  /** The threads the roots' trees are made of. */
  all: readonly ThreadSummary[];
  hasMore: boolean;
  /** Its read has not answered yet. */
  pending: boolean;
}

/** What Home read from a host: its threads as the sidebar lists them, and every project's name. */
export interface HomeList {
  /** Pins, the rest and snoozed threads, as the desktop's sidebar reads them. */
  days: SidebarDayList;
  /** Every project's name by id, Workspace's included. */
  names: ReadonlyMap<string, string>;
  /** The projects Home groups threads by, in the space's order, less the workspaces the person hid. */
  groups: readonly HomeProject[];
  /** The group key of every id a thread may carry for its project; a project of this Mac is its own key. */
  groupOf: ReadonlyMap<string, string>;
  /** The host could not list its threads. */
  failed: boolean;
  /** The host answered with its list. */
  listed: boolean;
  /**
   * A project's Resolved by its group's key, or null where the host says the project holds no resolved thread. An older
   * Mac never says, so there every project keeps one.
   */
  resolved: (projectId: string) => ProjectResolved | null;
}

/** A part of the whole list that folds under its label: Pinned or Snoozed. */
export type HomePart = "pinned" | "snoozed";

/** The room above a label: a little at the list's top, none right under another label, so a run of folded groups stacks tight. */
export type HeadingRoom = "first" | "after-rows" | "after-heading";

/** One row of Home's list. Labels and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /** Pinned's or Snoozed's label, with how many it holds. */
  | { kind: "section"; key: string; part: HomePart; label: string; count: number; open: boolean; room?: HeadingRoom }
  /**
   * A project's label over its threads, with how many of them wait on the person. `offline` when it is a cloud project
   * none of whose threads OpenOrc Cloud reaches now: its rows leave the cloud to its label, which dims.
   */
  | { kind: "project"; key: string; project: HomeProject; open: boolean; waiting: number; working?: true; offline?: true; room?: HeadingRoom }
  /**
   * `project` is the name a root row's label says, outside its project's group; rows in their group, and sub threads,
   * say none. `cloudLabel` when its group's label wears the cloud already. `arriving` rises it in.
   */
  | { kind: "thread"; key: string; thread: ThreadSummary; tree: ThreadTreeRow; project: string | null; arriving: boolean; cloudLabel?: true }
  /** The day a project's rows under it last worked: Yesterday, or Earlier. Today's rows lead with none. */
  | { kind: "day"; key: string; label: string }
  /** The last part of an open project's group: its Resolved, folded until the reader opens it. */
  | { kind: "resolved"; key: string; projectId: string; open: boolean }
  /** The foot of a project's open Resolved while the host has more of it to give. */
  | { kind: "resolved-more"; key: string; projectId: string }
  /** An open Resolved with nothing to list: still reading (`pending`), or empty. */
  | { kind: "resolved-none"; key: string; pending: boolean }
  /** The foot of Pinned, under the pinned filter, while the host has more threads to give. */
  | { kind: "more"; key: string }
  /** The foot of a project's group while it holds more threads than it shows. */
  | { kind: "group-more"; key: string; projectId: string; count: number }
  | { kind: "children-more"; key: string; tree: ThreadTreeRow; count: number }
  /** A list the host could not give: the projects, or the threads. */
  | { kind: "retry"; key: string; projects: boolean }
  /** Under a space's only project when it holds no threads yet. */
  | { kind: "empty"; key: string };

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

/** Whether OpenOrc Cloud reaches none of a cloud project's threads now, as each one's row would dim its own cloud. */
const cloudOffline = (roots: readonly ThreadSummary[]): boolean => roots.length > 0 && roots.every((root) => root.owner?.reach !== "live");

/** Rows for some roots and their trees, each parent's next page of sub threads at the foot of its tree. */
function treeRows(
  roots: readonly ThreadSummary[],
  list: HomeList,
  options: HomeOptions,
  { named, arriving, cloudLabel = false, all = list.days.all }: { named: boolean; arriving: boolean; cloudLabel?: boolean; all?: readonly ThreadSummary[] },
): HomeItem[] {
  const trees = threadTreeRows(roots, all, options.collapsed, options.selectedId ? [options.selectedId] : [], options.childLimits);
  const items: HomeItem[] = [];
  const pages: ThreadTreeRow[] = [];
  const end = () => {
    const tree = pages.pop()!;
    items.push({ kind: "children-more", key: `children-more:${tree.thread.id}`, tree, count: tree.hiddenChildren! });
  };
  for (const tree of trees) {
    while (pages.length && pages.at(-1)!.depth >= tree.depth) end();
    const project = named && !tree.depth ? (list.names.get(tree.thread.projectId) ?? null) : null;
    items.push({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project, arriving, ...(cloudLabel ? { cloudLabel: true as const } : {}) });
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
  more?: boolean;
}

function partItems({ part, label, roots, more }: Part, list: HomeList, options: HomeOptions): HomeItem[] {
  if (!roots.length) return [];
  const key = sidebarFoldKey[part](SIDEBAR_LIST);
  const open = sidebarSectionOpen(options.collapsed, part, SIDEBAR_LIST);
  return [
    { kind: "section", key, part, label, open, count: roots.length },
    ...treeRows(list.days.shown(roots, open), list, options, { named: true, arriving: options.opened === key }),
    ...(open && more ? [{ kind: "more", key: `more:${key}` } as const] : []),
  ];
}

/**
 * An open project's rows by the days they last worked, as the desktop's sidebar files them: today's lead with no
 * label, each later day under its own.
 */
function dayItems(project: HomeProject, rows: readonly ThreadSummary[], list: HomeList, options: HomeOptions, drawn: { arriving: boolean; cloudLabel: boolean }): HomeItem[] {
  return projectDaySections(rows, list.days.all, options.now).flatMap(({ day, label, roots }) => [
    ...(label ? [{ kind: "day", key: `day:${project.id}:${day}`, label } as const] : []),
    ...treeRows(roots, list, options, { named: false, ...drawn }),
  ]);
}

/**
 * A project's Resolved, the last part of its group: its door, then, open, its rows and its paging, or why it lists
 * none. A folded project keeps only the open thread's tree, with no door. `listed` are the roots the list already
 * shows, which a read a moment older may still hold.
 */
function resolvedItems(project: HomeProject, groupOpen: boolean, listed: ReadonlySet<string>, list: HomeList, options: HomeOptions): HomeItem[] {
  const part = list.resolved(project.id);
  if (!part) return [];
  const key = sidebarFoldKey.resolved(project.id);
  const roots = part.roots.filter((root) => !listed.has(root.id));
  const rows = treeRows(roots, list, options, { named: false, arriving: options.opened === key, cloudLabel: Boolean(project.cloud), all: part.all });
  if (!groupOpen) return rows;
  const foot = (): HomeItem[] => {
    if (part.hasMore) return [{ kind: "resolved-more", key: `more:${key}`, projectId: project.id }];
    return roots.length ? [] : [{ kind: "resolved-none", key: `none:${key}`, pending: part.pending }];
  };
  return [{ kind: "resolved", key, projectId: project.id, open: part.open }, ...rows, ...(part.open ? foot() : [])];
}

/**
 * Each project's group in the layout's order: its label with what waits on the person counted, then its rows by day,
 * then "Show N more", then its Resolved. A group with nothing in it, resolved threads neither, stands only when it is
 * the only project's.
 */
function groupItems(list: HomeList, options: HomeOptions): HomeItem[] {
  const holds = (group: Group) => group.roots.length > 0 || list.resolved(group.project.id) !== null;
  // No project stands only while it holds threads, resolved ones too, as on the Mac's sidebar.
  const all = groupsOf(list).filter((group) => group.project.id !== WORKSPACE_ID || holds(group));
  const groups = all.length === 1 ? all : all.filter(holds);
  const place = (group: Group) => options.layout.projects.indexOf(group.project.id);
  const active = holding(list);
  const listed = new Set([...list.days.pinned, ...list.days.rest, ...list.days.snoozed].map((root) => root.id));
  return [...groups]
    .sort((a, b) => place(a) - place(b))
    .flatMap(({ project, roots }) => {
      const key = sidebarFoldKey.project(project.id);
      const open = sidebarSectionOpen(options.collapsed, "project", project.id);
      const shown = projectRows(roots, { rows: options.layout.rows.get(project.id) ?? [], open, holdsActive: (root) => active.has(root.id) });
      return [
        {
          kind: "project",
          key,
          project,
          open,
          waiting: waitingRoots(roots, list.days.all),
          ...(roots.some((root) => root.activity === "running") ? { working: true as const } : {}),
          ...(project.cloud && cloudOffline(roots) ? { offline: true as const } : {}),
        } as const,
        ...(open
          ? dayItems(project, shown.rows, list, options, { arriving: options.opened === key, cloudLabel: Boolean(project.cloud) })
          : treeRows(shown.rows, list, options, { named: false, arriving: false, cloudLabel: Boolean(project.cloud) })),
        ...(shown.hidden ? [{ kind: "group-more", key: `group-more:${project.id}`, projectId: project.id, count: shown.hidden } as const] : []),
        ...resolvedItems(project, open, listed, list, options),
        ...(holds({ project, roots }) || list.days.pinned.length || list.failed || !list.listed ? [] : [{ kind: "empty", key: "empty" } as const]),
      ];
    });
}

/**
 * Home, as the desktop's sidebar lists threads: pinned threads first, then each project's group, its rows by the day
 * they last worked and its own Resolved at its end, which holds what was put there and everything quiet since before
 * yesterday, then snoozed threads. Under the pinned filter, the pins alone.
 */
export function homeItems(list: HomeList, options: HomeOptions): HomeItem[] {
  const { days } = list;
  return withRooms([
    ...(options.projectsFailed ? [{ kind: "retry", key: "retry:projects", projects: true } as const] : []),
    ...partItems({ part: "pinned", label: "Pinned", roots: days.pinned, more: options.pinnedOnly && days.hasMore }, list, options),
    ...(options.pinnedOnly ? [] : groupItems(list, options)),
    ...(list.failed ? [{ kind: "retry", key: "retry:threads", projects: false } as const] : []),
    ...partItems({ part: "snoozed", label: "Snoozed", roots: days.snoozed }, list, options),
  ]);
}

/**
 * Each label with the room above it, read from the row before it as the list is made: a row drawn later never looks at
 * its neighbours, which a list that just shrank may no longer hold.
 */
function withRooms(items: HomeItem[]): HomeItem[] {
  return items.map((item, index) => {
    if (item.kind !== "section" && item.kind !== "project") return item;
    const before = items[index - 1]?.kind;
    if (!before) return { ...item, room: "first" };
    return { ...item, room: before === "section" || before === "project" ? "after-heading" : "after-rows" };
  });
}

/** Something in Home's groups that calls the person, and the item that stands for it: its row, or its folded project's label. */
export type HomeCall = { id: string; title: string; status: ThreadStatus; anchor: string };

/**
 * What calls the person in the projects' groups (a question, a failure or a result not yet read), in the list's order:
 * each by its row, or by its project's label while the project is folded, as the desktop's edge lines read them.
 */
export function homeCalls(items: readonly HomeItem[], list: HomeList): HomeCall[] {
  const byProject = new Map(groupsOf(list).map((group) => [group.project.id, group.roots]));
  const statuses = rootStatuses(list.days.rest, list.days.all);
  const rows = new Set(items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])));
  const calls: HomeCall[] = [];
  let inGroup = false;
  for (const item of items) {
    if (item.kind === "section") inGroup = false;
    if (item.kind === "project") {
      inGroup = true;
      if (!item.open)
        for (const root of byProject.get(item.project.id) ?? []) {
          const status = statuses.get(root.id);
          // The open thread a folded group still shows stands for itself.
          if (!rows.has(root.id) && callsThePerson(status)) calls.push({ id: root.id, title: root.title, status: status!, anchor: item.key });
        }
    }
    if (item.kind === "thread" && inGroup && !item.tree.depth) {
      const status = statuses.get(item.thread.id);
      if (callsThePerson(status)) calls.push({ id: item.thread.id, title: item.thread.title, status: status!, anchor: item.key });
    }
  }
  return calls;
}
