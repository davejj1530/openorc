import { projectMeta, sidebarThreadPage, THREAD_PAGE, type ProjectMeta } from "@openorc/client";
import { WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";

/** One project as Home reads it: its first page of active threads, undefined until the Mac answers. */
export interface ProjectThreads {
  id: string;
  name: string;
  threads: readonly ThreadSummary[] | undefined;
}

/** One row of Home's list. Headings and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /** `open` while the section lists threads, as the sidebar's folder opens while its threads show. */
  | { kind: "heading"; key: string; group: "needs-you" | "workspace" | "project"; title: string; meta: ProjectMeta | null; open: boolean }
  | { kind: "pinned"; key: string; count: number }
  /** `project` names the thread's project where the section does not, as under Needs you. */
  | { kind: "thread"; key: string; thread: ThreadSummary; project: string | null };

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastActivityAt - a.lastActivityAt;
const waiting = (thread: ThreadSummary) => thread.activity === "waiting";

/**
 * Home: every thread waiting on you first, across projects, then Workspace and each project as the sidebar lists
 * it, pinned threads ahead of the rest. A waiting thread appears once, under Needs you.
 */
export function homeItems(groups: readonly ProjectThreads[], now: number): HomeItem[] {
  const pages = groups.map((group) => ({ group, page: sidebarThreadPage({ projectId: group.id, fetched: group.threads, selected: null, filter: "active", limit: THREAD_PAGE, now }) }));
  const needsYou = pages
    .flatMap(({ group, page }) => [...page.pinned, ...page.rest].filter(waiting).map((thread) => ({ thread, project: group.name })))
    .sort((a, b) => newestFirst(a.thread, b.thread));
  const items: HomeItem[] = [];
  if (needsYou.length) {
    items.push({ kind: "heading", key: "needs-you", group: "needs-you", title: "Needs you", meta: { text: String(needsYou.length), tone: "attention" }, open: true });
    for (const { thread, project } of needsYou) items.push({ kind: "thread", key: thread.id, thread, project });
  }
  for (const { group, page } of pages) {
    const pinned = page.pinned.filter((thread) => !waiting(thread));
    const rest = page.rest.filter((thread) => !waiting(thread));
    const meta = projectMeta(page.list, { loaded: group.threads !== undefined, more: page.hasMore });
    items.push({ kind: "heading", key: `project:${group.id}`, group: group.id === WORKSPACE_ID ? "workspace" : "project", title: group.name, meta, open: pinned.length + rest.length > 0 });
    if (pinned.length) items.push({ kind: "pinned", key: `pinned:${group.id}`, count: pinned.length });
    for (const thread of [...pinned, ...rest]) items.push({ kind: "thread", key: thread.id, thread, project: null });
  }
  return items;
}
