import { WORKSPACE_ID, type Project, type ThreadSummary } from "@openorc/protocol";

/** One row of Home's list. Headings and threads share one flat list so the virtualizer can recycle by kind. */
export type HomeItem =
  /** `open` while the section lists threads, as the sidebar's folder opens while its threads show. */
  | { kind: "heading"; key: string; group: "needs-you" | "workspace" | "project"; title: string; meta: string; open: boolean }
  | { kind: "pinned"; key: string; count: number }
  /** `project` names the thread's project where the section does not, as under Needs you. */
  | { kind: "thread"; key: string; thread: ThreadSummary; project: string | null };

const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.lastActivityAt - a.lastActivityAt;

/** A project heading's meta, as the desktop sidebar words it: how many are running, else how many threads it lists. */
function groupMeta(threads: readonly ThreadSummary[]): string {
  const running = threads.filter((thread) => thread.activity === "running").length;
  if (running) return `${running} running`;
  if (!threads.length) return "No threads";
  return `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`;
}

/**
 * Home: every thread waiting on you first, across projects, then Workspace and each project with its pinned threads
 * ahead of the rest, newest first. A waiting thread appears once, under Needs you.
 */
export function homeItems(projects: readonly Project[], threads: readonly ThreadSummary[]): HomeItem[] {
  const names = new Map<string, string>([[WORKSPACE_ID, "Workspace"], ...projects.map((project) => [project.id, project.name] as const)]);
  const waiting = threads.filter((thread) => thread.activity === "waiting").sort(newestFirst);
  const items: HomeItem[] = [];
  if (waiting.length) {
    items.push({ kind: "heading", key: "needs-you", group: "needs-you", title: "Needs you", meta: String(waiting.length), open: true });
    for (const thread of waiting) items.push({ kind: "thread", key: thread.id, thread, project: names.get(thread.projectId) ?? null });
  }
  for (const [id, title] of names) {
    const listed = threads.filter((thread) => thread.projectId === id && thread.activity !== "waiting").sort(newestFirst);
    const pinned = listed.filter((thread) => thread.pinnedAt !== null);
    const rest = listed.filter((thread) => thread.pinnedAt === null);
    items.push({ kind: "heading", key: `project:${id}`, group: id === WORKSPACE_ID ? "workspace" : "project", title, meta: groupMeta(listed), open: listed.length > 0 });
    if (pinned.length) items.push({ kind: "pinned", key: `pinned:${id}`, count: pinned.length });
    for (const thread of [...pinned, ...rest]) items.push({ kind: "thread", key: thread.id, thread, project: null });
  }
  return items;
}
