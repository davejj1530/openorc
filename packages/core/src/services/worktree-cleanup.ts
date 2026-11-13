import { frozenMoving, projects, retiredTeams, tasks, threads, type Db } from "@openorc/db";
import { diskUsage } from "@openorc/git";
import { WORKSPACE_ID, WORKTREE_BLOCK_WORDS, type Project, type Task, type Thread, type WorktreeBlock, type WorktreeEntry, type WorktreeOwner, type WorktreeRemoval } from "@openorc/protocol";
import { stat } from "node:fs/promises";
import type { RunService } from "./runs.js";
import { inUnvettedCopy } from "./review-copies.js";
import type { WorkspaceService } from "./workspace.js";
import type { WorkspaceWriters } from "./workspace-writers.js";

type Holder = { kind: "thread"; record: Thread; hidden: boolean } | { kind: "task"; record: Task; hidden: boolean };

/** One worktree folder and every record that points at it: a thread, its forks and started threads, a legacy task. */
interface Folder {
  path: string;
  project: Project;
  holders: Holder[];
}

export interface WorktreeCleanupDeps {
  db: Db;
  workspaces: Pick<WorkspaceService, "cleanupThread" | "cleanup" | "cloudState">;
  runs: Pick<RunService, "liveRunForThread" | "liveRunForTask" | "threadActivity" | "threadBackgroundCommands" | "closeAndWait">;
  writers: Pick<WorkspaceWriters, "withLease" | "writing">;
  invalidate: (keys: string[]) => void;
}

const SIZING = 4;

async function isFolder(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );
}

async function mapBounded<T, R>(items: readonly T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await each(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const owns = (holder: Holder, owner: WorktreeOwner) => holder.kind === owner.kind && holder.record.id === owner.id;

/** Subagent threads read their parent's folder and never prepare one of their own. */
const sharers = (folder: Folder) => folder.holders.filter((holder) => !(holder.kind === "thread" && holder.record.parentRelation === "subagent"));

/** The row's face: the thread the folder was made for, before its forks and started threads, else the task. */
function primary(folder: Folder): Holder {
  const visible = sharers(folder).filter((holder) => !holder.hidden);
  const byAge = [...visible].sort((a, b) => a.record.createdAt - b.record.createdAt);
  return byAge.find((holder) => holder.kind === "thread" && !holder.record.forkedFromId && !holder.record.parentThreadId) ?? byAge.find((holder) => holder.kind === "thread") ?? byAge[0]!;
}

type SuggestionFacts = Pick<WorktreeEntry, "lastActivityAt" | "archivedAt" | "pinnedAt" | "snoozedUntil" | "parentThreadId" | "prState">;

/** A legacy task counts as put away once it is done or archived. */
function suggestionFacts(holder: Holder): SuggestionFacts {
  if (holder.kind === "thread") {
    const { lastActivityAt, archivedAt, pinnedAt, snoozedUntil, parentThreadId, prState } = holder.record;
    return { lastActivityAt, archivedAt, pinnedAt, snoozedUntil, parentThreadId: parentThreadId ?? null, prState };
  }
  const task = holder.record;
  const putAway = task.status === "done" || task.status === "archived";
  return { lastActivityAt: task.updatedAt, archivedAt: putAway ? task.updatedAt : null, pinnedAt: null, snoozedUntil: null, parentThreadId: null, prState: null };
}

/**
 * Lists and removes worktree folders while keeping their branches and conversations. Removal goes through
 * WorkspaceService.cleanupThread and cleanup, which commit uncommitted work to the branch first; a thread's next
 * message makes its worktree again on that branch.
 */
export class WorktreeCleanup {
  constructor(private readonly deps: WorktreeCleanupDeps) {}

  /** Every record pointing at a worktree, retired ones included so a folder they share is never taken from them. */
  private folders(): Folder[] {
    const { db } = this.deps;
    const rows = db
      .stmt(
        `SELECT 'thread' AS kind, id, worktree_path AS path, project_id AS projectId FROM threads WHERE workspace_mode = 'worktree' AND worktree_path IS NOT NULL AND project_id != ?
         UNION ALL SELECT 'task', id, worktree_path, project_id FROM tasks WHERE workspace_mode = 'worktree' AND worktree_path IS NOT NULL AND project_id != ?`,
      )
      .all(WORKSPACE_ID, WORKSPACE_ID) as { kind: "thread" | "task"; id: string; path: string; projectId: string }[];
    const byPath = new Map<string, Folder>();
    for (const row of rows) {
      const project = projects.get(db, row.projectId);
      if (!project) continue;
      const holder = this.holder(row.kind, row.id);
      if (!holder) continue;
      const folder = byPath.get(row.path) ?? { path: row.path, project, holders: [] };
      folder.holders.push(holder);
      byPath.set(row.path, folder);
    }
    // A folder only retired records point at is theirs; it is neither listed nor removed.
    return [...byPath.values()].filter((folder) => sharers(folder).some((holder) => !holder.hidden));
  }

  private holder(kind: "thread" | "task", id: string): Holder | null {
    const { db } = this.deps;
    if (kind === "thread") {
      const record = threads.get(db, id);
      return record ? { kind, record, hidden: retiredTeams.isHidden(db, id) } : null;
    }
    const record = tasks.get(db, id);
    return record ? { kind, record, hidden: retiredTeams.hasTask(db, id) } : null;
  }

  /**
   * Why the folder must stay. Threads alone may share a folder: they keep pointing at it and make it again on their
   * shared branch. A legacy task beside a thread keeps the folder for its saved review history, and a retired record
   * for its own, so those folders stay.
   */
  private async blocked(folder: Folder, leased = false): Promise<WorktreeBlock | null> {
    const { runs, workspaces, writers, db } = this.deps;
    const holders = sharers(folder);
    const taskCount = holders.filter((holder) => holder.kind === "task").length;
    if (holders.some((holder) => holder.hidden) || taskCount > 1 || (taskCount === 1 && holders.length > 1)) return "shared";
    if (holders.some((holder) => holder.kind === "thread" && workspaces.cloudState(holder.record.id) !== null)) return "cloud";
    const busy = folder.holders.some((holder) =>
      holder.kind === "task"
        ? Boolean(runs.liveRunForTask(holder.record.id))
        : runs.threadActivity(holder.record.id) !== "idle" || runs.threadBackgroundCommands(holder.record.id).length > 0 || frozenMoving(db, holder.record.id) !== null,
    );
    // Holding the folder's lease is what proves no other workspace operation is in it.
    if (busy || (!leased && (await writers.writing(folder.path)))) return "working";
    return null;
  }

  async list(): Promise<WorktreeEntry[]> {
    const present = (await mapBounded(this.folders(), SIZING, async (folder) => ((await isFolder(folder.path)) ? folder : null))).filter((folder) => folder !== null);
    return mapBounded(present, SIZING, async (folder) => {
      const face = primary(folder);
      return {
        owner: { kind: face.kind, id: face.record.id },
        title: face.record.title,
        projectId: folder.project.id,
        projectName: folder.project.name,
        path: folder.path,
        branch: face.record.branch,
        bytes: await diskUsage(folder.path),
        ...suggestionFacts(face),
        lastActivityAt: Math.max(...sharers(folder).map((holder) => suggestionFacts(holder).lastActivityAt)),
        blocked: await this.blocked(folder),
      };
    });
  }

  /** Removes each owner's folder in turn; a failure is reported and the rest go ahead. */
  async remove(owners: readonly WorktreeOwner[]): Promise<WorktreeRemoval> {
    const result: WorktreeRemoval = { removed: [], failed: [] };
    for (const owner of owners) {
      try {
        await this.removeOne(owner);
        result.removed.push(owner);
      } catch (error) {
        result.failed.push({ owner, message: error instanceof Error ? error.message : String(error) });
      }
    }
    this.deps.invalidate(["worktrees", "threads", "tasks", "inbox", "workspace-diff", ...owners.map((owner) => (owner.kind === "thread" ? `thread:${owner.id}` : `task:${owner.id}`))]);
    return result;
  }

  private async removeOne(owner: WorktreeOwner): Promise<void> {
    const { runs, workspaces, writers } = this.deps;
    const found = this.folders().find((folder) => folder.holders.some((holder) => owns(holder, owner)));
    if (!found) throw new Error("This worktree is already gone.");
    const refuse = async (folder: Folder, leased = false) => {
      const blocked = await this.blocked(folder, leased);
      if (blocked) throw new Error(WORKTREE_BLOCK_WORDS[blocked]);
    };
    // An agent waiting between turns is closed first, as deleting does; the next message resumes it.
    await refuse(found);
    for (const holder of found.holders) {
      const live = holder.kind === "thread" ? runs.liveRunForThread(holder.record.id) : null;
      if (live) await runs.closeAndWait(live.id);
    }
    await writers.withLease(found.path, `removing worktree ${found.path}`, async (lease) => {
      const folder = this.folders().find((each) => each.path === found.path);
      if (!folder) throw new Error("This worktree is already gone.");
      await refuse(folder, true);
      const holders = sharers(folder);
      const face = primary(folder);
      if (face.kind === "task") {
        await workspaces.cleanup(face.record, folder.project, {}, lease);
        return;
      }
      // A pull request's copy under review is someone else's code, so any changes in it go with it.
      const save = !holders.some((holder) => holder.kind === "thread" && inUnvettedCopy(this.deps.db, holder.record));
      await workspaces.cleanupThread(face.record, folder.project, { save, keepPath: holders.length > 1 }, lease);
    });
  }
}
