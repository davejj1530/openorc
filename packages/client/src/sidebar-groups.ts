import type { ThreadSummary } from "@openorc/protocol";
import { SIDEBAR_LIST } from "./sidebar-days.js";
import { sidebarFoldKey } from "./sidebar-thread-groups.js";
import { threadStatus, threadTreeStatus, type ThreadStatus } from "./thread-row.js";
import { subthreadStatuses } from "./thread-tree.js";

/** The saved key that marks the whole Workspaces list folded. It starts open. */
export const WORKSPACES_FOLD = "workspaces-closed";

const GROUPED_FOLDS: ReadonlySet<string> = new Set([sidebarFoldKey.pinned(SIDEBAR_LIST), sidebarFoldKey.snoozed(SIDEBAR_LIST), sidebarFoldKey.resolved(SIDEBAR_LIST), WORKSPACES_FOLD]);

/**
 * Whether a saved fold names a part of the list grouped by project: a sub thread tree, a project's group, Pinned,
 * Snoozed, Resolved, or the whole of Workspaces.
 */
export function liveGroupedFold(key: string): boolean {
  return /^(thread-(open|closed)|project):/.test(key) || GROUPED_FOLDS.has(key);
}

/**
 * A project as its group heads the list: its id, its name, and its folder for the icon its menu chooses. `cloud`: a
 * project of OpenOrc Cloud's that no project on this Mac stands for, which has no folder and no actions here.
 */
export type GroupProject = { id: string; name: string; rootPath?: string; cloud?: true };

/** The projects only OpenOrc Cloud has, named by the rows that live in them, by name, so their order never follows work. */
export function cloudProjects(rows: readonly ThreadSummary[]): GroupProject[] {
  const named = new Map<string, string>();
  for (const row of rows) if (row.owner?.project && !named.has(row.projectId)) named.set(row.projectId, row.owner.project.name);
  return [...named].map(([id, name]) => ({ id, name, cloud: true as const })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** One project's part of the list: its threads' roots in the list's order, and how many of them wait on the person. */
export type ProjectGroup = { project: GroupProject; roots: ThreadSummary[]; waiting: number };

/**
 * A question or a failure: what only the person can move, and all a count in the sidebar counts. An unread result is
 * marked on its row and counted nowhere; work under way waits on no one.
 */
export function waitsOnYou(status: ThreadStatus | null): boolean {
  return status?.kind === "waiting" || status?.kind === "failed";
}

/** How many of these roots wait on the person, each counted once with its sub threads. */
export function waitingRoots(roots: readonly ThreadSummary[], all: readonly ThreadSummary[]): number {
  const below = subthreadStatuses(all);
  return roots.filter((root) => waitsOnYou(threadTreeStatus(threadStatus(root), below.get(root.id) ?? null))).length;
}

/**
 * The roots in their projects' groups, in the order the projects come, each keeping the list's order inside it. Every
 * project has its group, an empty one too; a root of a project not named here is left out.
 */
export function projectGroups(projects: readonly GroupProject[], roots: readonly ThreadSummary[], all: readonly ThreadSummary[]): ProjectGroup[] {
  const byProject = new Map<string, ThreadSummary[]>(projects.map((project) => [project.id, []]));
  for (const root of roots) byProject.get(root.projectId)?.push(root);
  return projects.map((project) => {
    const own = byProject.get(project.id) ?? [];
    return { project, roots: own, waiting: waitingRoots(own, all) };
  });
}
