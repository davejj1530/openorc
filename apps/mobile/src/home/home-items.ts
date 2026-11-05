import {
  projectMeta,
  sidebarFoldKey,
  sidebarSectionOpen,
  sidebarThreadPage,
  threadTreeRows,
  visibleThreadForest,
  type ProjectMeta,
  type SidebarFilter,
  type SidebarFold,
  type ThreadTreeRow,
} from "@openorc/client";
import { WORKSPACE_ID, type ThreadOwner, type ThreadSummary } from "@openorc/protocol";

/** One project as Home reads it: its pages of active threads so far, undefined until the Mac answers. */
export interface ProjectThreads {
  id: string;
  name: string;
  threads: readonly ThreadSummary[] | undefined;
  /** How many threads it shows: a page, and another for each Show more. */
  limit: number;
  /** The Mac could not list them. */
  failed: boolean;
}

/** One row of Home's list. Headings and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /**
   * `open` while the section shows its threads; a project's heading folds it and starts a thread there. `owner` is set by
   * whoever merged the section in, as on its rows.
   */
  | { kind: "heading"; key: string; group: "needs-you" | "workspace" | "project"; projectId: string | null; title: string; meta: ProjectMeta | null; open: boolean; owner?: ThreadOwner }
  /** A project's pinned or snoozed threads, behind a disclosure. */
  | { kind: "section"; key: string; fold: Exclude<SidebarFold, "project">; projectId: string; count: number; open: boolean }
  /**
   * `project` names the thread's project where the section does not, as under Needs you. `arriving` rises it in.
   * `host` names the partner host a thread under the shown host's Needs you lives on.
   */
  | { kind: "thread"; key: string; thread: ThreadSummary; tree: ThreadTreeRow; project: string | null; arriving: boolean; host?: string }
  /** The foot of a project that lists more threads than it shows. */
  | { kind: "more"; key: string; projectId: string; project: string }
  | { kind: "children-more"; key: string; tree: ThreadTreeRow; count: number }
  /** A list the Mac could not give: a project's threads, or with no project, the projects themselves. */
  | { kind: "retry"; key: string; projectId: string | null };

export interface HomeOptions {
  now: number;
  /** What Home lists: orcmode's working set, the active threads (only the pinned ones with `pinnedOnly`), or the archive. */
  filter: SidebarFilter;
  pinnedOnly: boolean;
  /** The reader's saved fold keys. */
  collapsed: readonly string[];
  /** Threads the Mac's inbox says wait on you, which may lie past the pages loaded so far. */
  waiting: readonly ThreadSummary[];
  /** The Mac could not list its projects. */
  projectsFailed: boolean;
  /** The project the reader just opened, whose rows rise in. */
  opened: string | null;
  childLimits?: Readonly<Record<string, number>>;
  selectedId?: string;
  /** The partner host's threads waiting on you, listed under this host's Needs you with its own. */
  partnerWaiting?: readonly Waiting[];
  /** This host is the partner: its waiting threads are listed under the shown host's Needs you, and none here. */
  waitingShownElsewhere?: boolean;
}

/** A thread waiting on you, with the project it is in; `host` is the partner host it lives on. */
export interface Waiting {
  thread: ThreadSummary;
  project: string | null;
  host?: string;
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastActivityAt - a.lastActivityAt;
const isWaiting = (thread: ThreadSummary) => thread.activity === "waiting";

/**
 * Every thread waiting on you, once each, newest first: from every thread the lists read, the one past a page's end
 * included (the inbox's reads skip what a list already read), and from the inbox.
 */
function needsYou(groups: readonly ProjectThreads[], all: readonly ThreadSummary[]): Waiting[] {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const found = new Map(all.filter((thread) => isWaiting(thread) && !thread.archivedAt && !thread.teamInstanceId).map((thread) => [thread.id, thread]));
  return [...found.values()].sort(newestFirst).map((thread) => ({ thread, project: names.get(thread.projectId) ?? null }));
}

type Page = ReturnType<typeof sidebarThreadPage>;

/** The archive lists every archived thread in its project; the other views leave waiting ones to Needs you. */
const listsWaiting = (options: HomeOptions) => options.filter === "archived";

function projectRows(group: ProjectThreads, page: Page, options: HomeOptions, waitingRoots: ReadonlySet<string>): HomeItem[] {
  const arriving = options.opened === group.id;
  const rows = (threads: readonly ThreadSummary[]): HomeItem[] => {
    const trees = threadTreeRows(
      threads.filter((thread) => !waitingRoots.has(thread.id)),
      page.list.filter((thread) => !waitingRoots.has(thread.id)),
      options.collapsed,
      options.selectedId ? [options.selectedId] : [],
      options.childLimits,
    );
    const items: HomeItem[] = [];
    const pages: ThreadTreeRow[] = [];
    const end = () => {
      const tree = pages.pop()!;
      items.push({ kind: "children-more", key: `children-more:${tree.thread.id}`, tree, count: tree.hiddenChildren! });
    };
    for (const tree of trees) {
      while (pages.length && pages.at(-1)!.depth >= tree.depth) end();
      items.push({ kind: "thread", key: tree.thread.id, thread: tree.thread, tree, project: null, arriving });
      if (tree.expanded && tree.hiddenChildren) pages.push(tree);
    }
    while (pages.length) end();
    return items;
  };
  const section = (fold: "pinned" | "snoozed", threads: readonly ThreadSummary[]): HomeItem[] => {
    const shown = rows(threads);
    if (!shown.length) return [];
    const open = sidebarSectionOpen(options.collapsed, fold, group.id);
    return [{ kind: "section", key: sidebarFoldKey[fold](group.id), fold, projectId: group.id, count: threads.filter((thread) => !waitingRoots.has(thread.id)).length, open }, ...(open ? shown : [])];
  };
  const pinnedOnly = options.pinnedOnly;
  return [
    ...section("pinned", page.pinned),
    ...(pinnedOnly ? [] : rows(page.rest)),
    ...(group.failed ? [{ kind: "retry", key: `retry:${group.id}`, projectId: group.id } as const] : []),
    // Orcmode shows its working set whole; it has no next page.
    ...(page.hasMore && options.filter !== "orc" ? [{ kind: "more", key: `more:${group.id}`, projectId: group.id, project: group.name } as const] : []),
    ...(pinnedOnly ? [] : section("snoozed", page.snoozed)),
  ];
}

/** Orcmode lists only the projects with something in its working set, or whose threads failed to load. */
const shownInOrcmode = ({ group, page }: { group: ProjectThreads; page: Page }) => group.failed || page.pinned.length + page.rest.length > 0;

/** Rows and headings another host owns, marked with it: the shown host's when it cannot be reached, all of the partner's. */
export function owned(items: HomeItem[], owner: ThreadOwner): HomeItem[] {
  return items.map((item) => {
    if (item.kind === "thread" && !item.host) return { ...item, thread: { ...item.thread, owner } };
    if (item.kind === "heading" && item.projectId) return { ...item, owner };
    return item;
  });
}

/** This host's threads waiting on you, newest first; none in the archive, which lists them in their projects. */
export function homeWaiting(groups: readonly ProjectThreads[], options: HomeOptions): Waiting[] {
  if (listsWaiting(options)) return [];
  const all = visibleThreadForest(
    [...new Map([...options.waiting, ...groups.flatMap((group) => group.threads ?? [])].map((thread) => [thread.id, thread])).values()],
    options.filter === "archived",
    options.now,
  );
  return needsYou(groups, all);
}

/**
 * Home: every thread waiting on you first, across projects and the partner host, then Workspace and each project as
 * the sidebar lists it, pinned threads ahead of the rest and snoozed ones folded at the foot, a page at a time. A
 * waiting thread appears once, under Needs you, which never folds, so a folded project still shows what waits on you.
 */
export function homeItems(groups: readonly ProjectThreads[], options: HomeOptions): HomeItem[] {
  const pages = groups.map((group) => ({
    group,
    page: sidebarThreadPage({
      projectId: group.id,
      fetched: group.threads,
      selected: group.threads?.find((thread) => thread.id === options.selectedId),
      filter: options.filter,
      limit: group.limit,
      now: options.now,
    }),
  }));
  const own = homeWaiting(groups, options);
  const waitingRoots = new Set(own.map(({ thread }) => thread.id));
  // A thread that just moved here may still wait in the partner's last list: this host's own row stands for it.
  const here = new Set([...options.waiting, ...groups.flatMap((group) => group.threads ?? [])].map((thread) => thread.id));
  const partner = (options.partnerWaiting ?? []).filter(({ thread }) => !here.has(thread.id));
  const waiting = options.waitingShownElsewhere ? [] : [...own, ...partner].sort((a, b) => newestFirst(a.thread, b.thread));
  const items: HomeItem[] = [];
  if (waiting.length) {
    items.push({ kind: "heading", key: "needs-you", group: "needs-you", projectId: null, title: "Needs you", meta: { text: String(waiting.length), tone: "attention" }, open: true });
    for (const { thread, project, host } of waiting) {
      for (const tree of threadTreeRows([thread], [thread], []))
        items.push({
          kind: "thread",
          key: host ? `${host}:${tree.thread.id}` : tree.thread.id,
          thread: tree.thread,
          tree,
          project: tree.depth ? null : project,
          arriving: false,
          ...(host ? { host } : {}),
        });
    }
  }
  if (options.projectsFailed) items.push({ kind: "retry", key: "retry:projects", projectId: null });
  for (const { group, page } of options.filter === "orc" ? pages.filter(shownInOrcmode) : pages) {
    const open = sidebarSectionOpen(options.collapsed, "project", group.id);
    const meta = projectMeta(page.list, { loaded: group.threads !== undefined, more: page.hasMore });
    items.push({ kind: "heading", key: sidebarFoldKey.project(group.id), group: group.id === WORKSPACE_ID ? "workspace" : "project", projectId: group.id, title: group.name, meta, open });
    if (open) items.push(...projectRows(group, page, options, waitingRoots));
  }
  return items;
}
