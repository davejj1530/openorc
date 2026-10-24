import { projectMeta, sidebarFoldKey, sidebarSectionOpen, sidebarThreadPage, type ProjectMeta, type SidebarFilter, type SidebarFold } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

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
  /** `open` while the section shows its threads; a project's heading folds it and starts a thread there. */
  | { kind: "heading"; key: string; group: "needs-you" | "workspace" | "project"; projectId: string | null; title: string; meta: ProjectMeta | null; open: boolean }
  /** A project's pinned or snoozed threads, behind a disclosure. */
  | { kind: "section"; key: string; fold: Exclude<SidebarFold, "project">; projectId: string; count: number; open: boolean }
  /** `project` names the thread's project where the section does not, as under Needs you. `arriving` rises it in. */
  | { kind: "thread"; key: string; thread: ThreadSummary; project: string | null; arriving: boolean }
  /** The foot of a project that lists more threads than it shows. */
  | { kind: "more"; key: string; projectId: string; project: string }
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
}

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastActivityAt - a.lastActivityAt;
const isWaiting = (thread: ThreadSummary) => thread.activity === "waiting";

/**
 * Every thread waiting on you, once each, newest first: from every thread the lists read, the one past a page's end
 * included (the inbox's reads skip what a list already read), and from the inbox.
 */
function needsYou(groups: readonly ProjectThreads[], waiting: readonly ThreadSummary[]) {
  const names = new Map(groups.map((group) => [group.id, group.name]));
  const found = new Map<string, ThreadSummary>();
  for (const group of groups) for (const thread of group.threads?.filter(isWaiting) ?? []) found.set(thread.id, thread);
  for (const thread of waiting) if (!found.has(thread.id) && !thread.archivedAt) found.set(thread.id, thread);
  return [...found.values()].sort(newestFirst).map((thread) => ({ thread, project: names.get(thread.projectId) ?? null }));
}

type Page = ReturnType<typeof sidebarThreadPage>;

/** The archive lists every archived thread in its project; the other views leave waiting ones to Needs you. */
const listsWaiting = (options: HomeOptions) => options.filter === "archived";

function projectRows(group: ProjectThreads, page: Page, options: HomeOptions): HomeItem[] {
  const arriving = options.opened === group.id;
  const rows = (threads: readonly ThreadSummary[]) =>
    threads.filter((thread) => listsWaiting(options) || !isWaiting(thread)).map((thread): HomeItem => ({ kind: "thread", key: thread.id, thread, project: null, arriving }));
  const section = (fold: "pinned" | "snoozed", threads: readonly ThreadSummary[]): HomeItem[] => {
    const shown = rows(threads);
    if (!shown.length) return [];
    const open = sidebarSectionOpen(options.collapsed, fold, group.id);
    return [{ kind: "section", key: sidebarFoldKey[fold](group.id), fold, projectId: group.id, count: shown.length, open }, ...(open ? shown : [])];
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

/**
 * Home: every thread waiting on you first, across projects, then Workspace and each project as the sidebar lists it,
 * pinned threads ahead of the rest and snoozed ones folded at the foot, a page at a time. A waiting thread appears
 * once, under Needs you, which never folds, so a folded project still shows what waits on you.
 */
export function homeItems(groups: readonly ProjectThreads[], options: HomeOptions): HomeItem[] {
  const pages = groups.map((group) => ({
    group,
    page: sidebarThreadPage({ projectId: group.id, fetched: group.threads, selected: null, filter: options.filter, limit: group.limit, now: options.now }),
  }));
  const waiting = listsWaiting(options) ? [] : needsYou(groups, options.waiting);
  const items: HomeItem[] = [];
  if (waiting.length) {
    items.push({ kind: "heading", key: "needs-you", group: "needs-you", projectId: null, title: "Needs you", meta: { text: String(waiting.length), tone: "attention" }, open: true });
    for (const { thread, project } of waiting) items.push({ kind: "thread", key: thread.id, thread, project, arriving: false });
  }
  if (options.projectsFailed) items.push({ kind: "retry", key: "retry:projects", projectId: null });
  for (const { group, page } of options.filter === "orc" ? pages.filter(shownInOrcmode) : pages) {
    const open = sidebarSectionOpen(options.collapsed, "project", group.id);
    const meta = projectMeta(page.list, { loaded: group.threads !== undefined, more: page.hasMore });
    items.push({ kind: "heading", key: sidebarFoldKey.project(group.id), group: group.id === WORKSPACE_ID ? "workspace" : "project", projectId: group.id, title: group.name, meta, open });
    if (open) items.push(...projectRows(group, page, options));
  }
  return items;
}
