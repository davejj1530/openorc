import { createHash, randomUUID } from "node:crypto";
import { realpath, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  audit,
  orchestration,
  projects,
  tasks,
  teamContexts,
  teamDeletedThreads,
  teamDeletions,
  teamForks,
  teamMoves,
  teamRestores,
  teamRoom,
  teamWorkspaces,
  threads,
  type Db,
  type TeamCleanupEntry,
  type TeamDeletionRecord,
} from "@openorc/db";
import type { Project, TeamActionAvailability, TeamInstance, TeamTaskView, Thread } from "@openorc/protocol";
import { buildTeamRetainedSeed } from "./team-context.js";
import { collectTeamGit, inventoryTeamGit } from "./team-git-cleanup.js";
import { checkpointRefs } from "./checkpoint-refs.js";
import { TeamOperationGuard } from "./team-operations.js";
import { teamTaskBranch } from "./team-task-export.js";
import { assertTeamCleanupUntouched, inspectTeamCleanup, pathContains, removeTeamCleanup, type TeamCleanupHooks } from "./team-workspace-cleanup.js";
import { WorkspaceWriters, type WorkspaceLease } from "./workspace-writers.js";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
interface DeleteInput {
  threadId: string;
  requestKey: string;
}
type DeleteResult = null | { rejected: string };
export interface TeamDeletionHooks {
  fault?(point: "retained" | "cleanup" | "applied", record: TeamDeletionRecord): Promise<void> | void;
  cleanup?: TeamCleanupHooks;
}
interface Inventory extends Pick<TeamDeletionRecord, "retainedTaskIds" | "deletedTaskIds" | "entries" | "retainedPaths" | "seed" | "throughExecutionRowid" | "git" | "exports"> {
  lease?: WorkspaceLease;
}

/**
 * Deleting a team conversation keeps a hidden owner while saved tasks survive;
 * without tasks it removes only workspaces this instance provably owns, through
 * a journaled quarantine so a retry never touches a recreated path. Deleting a
 * hidden owner again deletes its saved tasks together and finishes the same way,
 * then collects the branches, retention refs and exported patches it created.
 */
export class TeamDeletionService {
  private readonly operations = new Map<string, { hash: string; promise: Promise<DeleteResult> }>();
  private readonly fences = new Map<string, WorkspaceLease>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly guard: TeamOperationGuard,
    private readonly writers: WorkspaceWriters,
    private readonly changed: (threadId: string) => void,
    private readonly hooks: TeamDeletionHooks = {},
  ) {}

  availability(threadId: string): TeamActionAvailability {
    try {
      const reason = this.guard.reason(threadId, teamDeletions.pending(this.db, threadId)[0]?.id, { retainedTask: true });
      if (reason) throw new Error(reason);
      return { allowed: true, reason: null };
    } catch (error) {
      return { allowed: false, reason: errorText(error) };
    }
  }

  /** What deleting a hidden owner's saved tasks would do; absent while the owner is an ordinary conversation. */
  ownerDeletion(threadId: string): TeamTaskView["deleteOwner"] {
    if (!teamDeletedThreads.has(this.db, threadId)) return undefined;
    const recovery = this.recovery(threadId);
    return {
      ...this.availability(threadId),
      taskIds: tasks
        .list(this.db, { threadId })
        .map((task) => task.id)
        .sort(),
      ...(recovery ? { recovery } : {}),
    };
  }

  recovery(threadId: string): { requestKey: string; error: string | null } | undefined {
    const pending = teamDeletions.pending(this.db, threadId)[0];
    return pending ? { requestKey: pending.requestKey, error: pending.error } : undefined;
  }

  delete(input: DeleteInput): Promise<DeleteResult> {
    if (this.closing) return Promise.reject(new Error("Team deletions are shutting down."));
    if (!input.requestKey.trim() || input.requestKey.length > 200) return Promise.reject(new Error("Deleting a team conversation requires a bounded request key."));
    const key = JSON.stringify([input.threadId, input.requestKey]);
    const hash = createHash("sha256")
      .update(JSON.stringify([input.threadId, "delete"]))
      .digest("hex");
    const previous = this.operations.get(key);
    if (previous) return previous.hash === hash ? previous.promise : Promise.reject(new Error("This delete key already identifies different work."));
    const promise = this.perform(input, hash)
      .catch((error) => {
        // Only a durable negative receipt proves that a request can never later apply.
        if (teamDeletions.find(this.db, input.threadId, input.requestKey)) throw error;
        const rejection = teamDeletions.reject(this.db, { threadId: input.threadId, requestKey: input.requestKey, requestHash: hash, error: errorText(error) });
        return { rejected: rejection.error };
      })
      .finally(() => this.operations.delete(key));
    this.operations.set(key, { hash, promise });
    return promise;
  }

  /** Startup fences every interrupted cleanup before any workspace recovery or admission can touch its paths. */
  async recover(): Promise<void> {
    for (const receipt of teamDeletions.list(this.db)) {
      if (receipt.state === "applied" || receipt.state === "cancelled") continue;
      if (receipt.entries.length && !this.fences.has(receipt.id)) this.fences.set(receipt.id, await this.acquire(receipt, `Recover team deletion ${receipt.id}`));
      teamDeletions.attention(this.db, receipt.id, "Deletion was interrupted. Retry it to finish; only its recorded team workspaces are affected.");
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise));
    for (const lease of this.fences.values()) lease.release();
    this.fences.clear();
  }

  async cancel(threadId: string, requestKey: string, keepFiles = false): Promise<{ state: "cancelled" | "applied" }> {
    if (this.closing || this.operations.has(JSON.stringify([threadId, requestKey]))) throw new Error("Wait for the current delete request to finish.");
    const receipt = teamDeletions.find(this.db, threadId, requestKey);
    if (!receipt) throw new Error("The delete request was not found. Refresh team status.");
    if (receipt.state === "applied") return { state: "applied" };
    if (receipt.state === "cancelled") return { state: threads.get(this.db, threadId) ? "cancelled" : "applied" };
    if (keepFiles && receipt.retainedTaskIds.length) throw new Error("Cancel this deletion to keep the conversation and its saved tasks.");
    const reservation = this.guard.reserve(threadId, receipt.id, { retainedTask: true });
    let lease = this.fences.get(receipt.id);
    try {
      lease ??= await this.acquire(receipt, `Cancel team deletion ${receipt.id}`);
      if (!keepFiles) {
        if (receipt.items.some((item) => item.state !== "pending")) throw new Error("Deletion already started. Finish deleting while keeping the remaining files instead.");
        for (const entry of receipt.entries) await assertTeamCleanupUntouched(entry);
      }
      reservation.assertCurrent();
      this.db.transaction(() => {
        teamDeletions.cancel(this.db, receipt.id);
        if (keepFiles) {
          threads.delete(this.db, threadId);
          for (const taskId of receipt.deletedTaskIds) tasks.delete(this.db, taskId);
          teamRoom.purge(this.db, receipt.instanceId);
        }
        audit.record(this.db, {
          actor: "user",
          action: "team.delete.cancel",
          resourceType: "thread",
          resourceId: threadId,
          metadata: { receiptId: receipt.id, keepFiles, retainedPaths: receipt.entries },
        });
      });
      this.fences.delete(receipt.id);
      lease.release();
      return { state: keepFiles ? "applied" : "cancelled" };
    } catch (error) {
      if (lease) this.fences.set(receipt.id, lease);
      throw error;
    } finally {
      reservation.release();
      this.changed(threadId);
    }
  }

  private acquire(receipt: TeamDeletionRecord, owner: string): Promise<WorkspaceLease> {
    return this.writers.acquire(
      receipt.entries.flatMap((entry) => [entry.canonicalPath, entry.quarantinePath]),
      owner,
    );
  }

  private resolveRequest(input: DeleteInput, hash: string): { receipt: TeamDeletionRecord | null } | { result: DeleteResult } {
    const rejected = teamDeletions.rejection(this.db, input.threadId, input.requestKey);
    if (rejected) {
      if (rejected.requestHash !== hash) throw new Error("This delete key already identifies different work.");
      return { result: { rejected: rejected.error } };
    }
    const receipt = teamDeletions.find(this.db, input.threadId, input.requestKey);
    if (receipt && receipt.requestHash !== hash) throw new Error("This delete key already identifies different work.");
    // A replayed response never deletes again, even after the owner or its paths were recreated.
    if (receipt?.state === "applied") return { result: null };
    if (receipt?.state === "cancelled") return { result: threads.get(this.db, input.threadId) ? { rejected: "This deletion was cancelled. Start a new request to delete the conversation." } : null };
    return { receipt };
  }

  private async perform(input: DeleteInput, hash: string): Promise<DeleteResult> {
    const resolved = this.resolveRequest(input, hash);
    if ("result" in resolved) return resolved.result;
    let { receipt } = resolved;
    const operationId = receipt?.id ?? randomUUID();
    const reservation = this.guard.reserve(input.threadId, operationId, { retainedTask: true });
    let lease: WorkspaceLease | undefined;
    let keepFence = false;
    try {
      const thread = threads.get(this.db, input.threadId)!;
      const instance = orchestration.getInstance(this.db, input.threadId)!;
      const project = projects.get(this.db, thread.projectId)!;
      if (!receipt) {
        const inventory = await this.inventory(thread, instance, project, operationId, () => reservation.assertCurrent());
        lease = inventory.lease;
        reservation.assertCurrent();
        receipt = teamDeletions.create(this.db, {
          id: operationId,
          threadId: thread.id,
          instanceId: instance.id,
          projectId: project.id,
          projectRoot: project.rootPath,
          requestKey: input.requestKey,
          requestHash: hash,
          retainedTaskIds: inventory.retainedTaskIds,
          deletedTaskIds: inventory.deletedTaskIds,
          entries: inventory.entries,
          retainedPaths: inventory.retainedPaths,
          seed: inventory.seed,
          throughExecutionRowid: inventory.throughExecutionRowid,
          git: inventory.git,
          exports: inventory.exports,
        });
        this.changed(thread.id);
      } else if (receipt.entries.length) {
        lease = this.fences.get(receipt.id) ?? (await this.acquire(receipt, `Delete team ${thread.id}`));
      }
      if (receipt.instanceId !== instance.id || receipt.projectId !== project.id || receipt.projectRoot !== project.rootPath)
        throw new Error("The deletion's original project or team changed. Its workspaces were preserved for recovery.");
      await this.hooks.fault?.("retained", receipt);
      reservation.assertCurrent();
      const accepted = receipt;
      if (accepted.retainedTaskIds.length) {
        // Saved tasks keep every workspace and their team. The owner only loses
        // its place in navigation and gets a fresh, task-only lead context.
        this.db.transaction(() => {
          threads.update(this.db, thread.id, { archivedAt: null, doneAt: null, snoozedUntil: null, pinnedAt: null, draft: null });
          const context = teamContexts.create(this.db, {
            instanceId: instance.id,
            executionId: null,
            actorId: "lead",
            originExecutionId: null,
            reason: "compact",
            requestKey: `delete:${accepted.id}`,
            seed: accepted.seed!,
          });
          teamDeletions.finish(this.db, accepted.id, { contextCheckpointId: context.id });
          audit.record(this.db, {
            actor: "user",
            action: "team.delete",
            resourceType: "thread",
            resourceId: thread.id,
            metadata: { receiptId: accepted.id, retainedTaskIds: accepted.retainedTaskIds, contextCheckpointId: context.id },
          });
        });
      } else {
        for (const [index, entry] of accepted.entries.entries()) {
          await removeTeamCleanup(
            entry,
            teamDeletions.get(this.db, accepted.id)!.items[index]!.state,
            (phase) => {
              teamDeletions.markItem(this.db, accepted.id, index, phase);
            },
            () => reservation.assertCurrent(),
            this.hooks.cleanup,
          );
          await this.hooks.fault?.("cleanup", teamDeletions.get(this.db, accepted.id)!);
        }
        reservation.assertCurrent();
        // Workspaces are gone, so owned branches are no longer checked out. Every
        // Git step is idempotent at its captured tip; a retry after a crash resumes safely.
        const collected = await collectTeamGit(project.rootPath, accepted.git, project.defaultBranch, () => reservation.assertCurrent());
        for (const file of accepted.exports) await rm(file, { force: true });
        reservation.assertCurrent();
        this.db.transaction(() => {
          audit.record(this.db, {
            actor: "user",
            action: "team.delete",
            resourceType: "thread",
            resourceId: thread.id,
            metadata: {
              receiptId: accepted.id,
              removedPaths: accepted.entries.map((entry) => entry.path),
              retainedPaths: accepted.retainedPaths,
              deletedTaskIds: accepted.deletedTaskIds,
              ...collected,
              removedExports: accepted.exports,
            },
          });
          // A retained owner keeps its room for the saved tasks' history; the room goes only when nothing retains the conversation.
          const instance = accepted.retainedTaskIds.length === 0 ? orchestration.getInstance(this.db, thread.id) : null;
          // The owner row goes first: retained-history guards release once no owner exists, then its tasks follow.
          threads.delete(this.db, thread.id);
          for (const taskId of accepted.deletedTaskIds) tasks.delete(this.db, taskId);
          if (instance) teamRoom.purge(this.db, instance.id);
          teamDeletions.finish(this.db, accepted.id);
        });
        await this.tidy(accepted);
      }
      this.changed(thread.id);
      await this.hooks.fault?.("applied", teamDeletions.get(this.db, accepted.id)!);
      return null;
    } catch (error) {
      const latest = receipt && teamDeletions.get(this.db, receipt.id);
      if (latest && latest.state !== "applied") {
        teamDeletions.attention(this.db, latest.id, errorText(error));
        if (lease && latest.entries.length) {
          this.fences.set(latest.id, lease);
          keepFence = true;
        }
      }
      throw error;
    } finally {
      if (!keepFence) {
        this.fences.delete(operationId);
        lease?.release();
      }
      reservation.release();
      this.changed(input.threadId);
    }
  }

  /**
   * Enumerate what this instance owns and prove nothing else references it.
   * Ownership never comes from a path's location; every candidate is a retained
   * record of this conversation, and every other owner's path is protected.
   */
  private async inventory(thread: Thread, instance: TeamInstance, project: Project, operationId: string, assertCurrent: () => void): Promise<Inventory> {
    const taskIds = tasks
      .list(this.db, { threadId: thread.id })
      .map((task) => task.id)
      .sort();
    const throughExecutionRowid = (this.db.stmt("SELECT COALESCE(MAX(rowid),0) AS value FROM team_executions WHERE thread_id=?").get(thread.id) as { value: number }).value;
    const none = { git: { branches: [], refPrefixes: [] }, exports: [] };
    if (taskIds.length && !teamDeletedThreads.has(this.db, thread.id)) {
      return {
        retainedTaskIds: taskIds,
        deletedTaskIds: [],
        entries: [],
        retainedPaths: [],
        throughExecutionRowid,
        ...none,
        seed: buildTeamRetainedSeed(this.db, { instanceId: instance.id, executionId: null, actorId: "lead" }, taskIds),
      };
    }
    // A hidden owner's saved tasks go together with it; nothing else may own them.
    const retainedTaskIds: string[] = [],
      deletedTaskIds = taskIds;
    const executions = new Set((this.db.stmt("SELECT id FROM team_executions WHERE instance_id=?").all(instance.id) as { id: string }[]).map((row) => row.id));
    const git = await inventoryTeamGit(project.rootPath, this.ownedBranches(thread, deletedTaskIds), this.ownedRefPrefixes(thread, executions));
    const exports = this.ownedExports(deletedTaskIds);
    assertCurrent();
    const candidates = new Map<string, string>();
    const candidate = (file: string | null | undefined, source: string) => {
      if (file && path.isAbsolute(file) && !candidates.has(path.normalize(file))) candidates.set(path.normalize(file), source);
    };
    for (const record of teamWorkspaces.list(this.db)) if (executions.has(record.executionId)) candidate(record.path, "team workspace");
    for (const publication of teamWorkspaces.publications(this.db)) if (executions.has(publication.executionId)) candidate(publication.scratchPath, "integration scratch");
    for (const file of teamForks.byDestinationThread(this.db, thread.id)?.paths ?? []) candidate(file, "fork candidate");
    for (const restore of teamRestores.forThread(this.db, thread.id)) for (const file of restore.paths) candidate(file, "restore candidate");
    for (const move of teamMoves.forThread(this.db, thread.id)) for (const item of move.paths) candidate(item.path, `move ${item.kind}`);
    const protectedPaths = this.protectedPaths(thread, executions);
    const retainedPaths: TeamDeletionRecord["retainedPaths"] = [];
    const entries: TeamCleanupEntry[] = [];
    const removable: string[] = [];
    for (const [file] of candidates) {
      const overlap = protectedPaths.find((other) => pathContains(other, file) || pathContains(file, other));
      if (overlap) retainedPaths.push({ path: file, reason: overlap === project.rootPath ? "project checkout" : `shared with ${overlap}` });
      else removable.push(file);
    }
    if (thread.worktreePath && !candidates.has(path.normalize(thread.worktreePath))) retainedPaths.push({ path: thread.worktreePath, reason: "workspace pointer without a retained owning record" });
    if (!removable.length) return { retainedTaskIds, deletedTaskIds, entries, retainedPaths, seed: null, throughExecutionRowid, git, exports };
    const quarantine = (file: string) => `${file}.openorc-delete-${operationId.slice(0, 8)}`;
    // Hold every candidate before inspecting it so its identity cannot change underneath the receipt.
    const lease = await this.writers.acquire(
      removable.flatMap((file) => [file, quarantine(file)]),
      `Delete team ${thread.id}`,
    );
    try {
      const seen = new Set<string>();
      for (const file of removable) {
        assertCurrent();
        try {
          const entry = await inspectTeamCleanup({ repositoryRoot: project.rootPath, path: file, quarantinePath: quarantine(file), allowPartialDirectory: true });
          if (seen.has(entry.canonicalPath)) continue;
          seen.add(entry.canonicalPath);
          entries.push(entry);
        } catch (error) {
          retainedPaths.push({ path: file, reason: errorText(error) });
        }
      }
      assertCurrent();
      return { retainedTaskIds, deletedTaskIds, entries, retainedPaths, seed: null, throughExecutionRowid, git, exports, lease };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /** Everything any other owner may reach: checkouts, other conversations, tasks, other instances' workspaces and candidates. */
  private protectedPaths(thread: Thread, executions: ReadonlySet<string>): string[] {
    const result = new Set<string>();
    const add = (file: string | null | undefined) => {
      if (file && path.isAbsolute(file)) result.add(path.normalize(file));
    };
    for (const project of projects.list(this.db, { includeRemoved: true })) add(project.rootPath);
    for (const row of this.db.stmt("SELECT worktree_path FROM threads WHERE id<>? AND worktree_path IS NOT NULL").all(thread.id) as { worktree_path: string }[]) add(row.worktree_path);
    // This owner's own tasks are deleted with it; their workspace pointers are its team workspaces.
    for (const row of this.db.stmt("SELECT worktree_path FROM tasks WHERE worktree_path IS NOT NULL AND thread_id IS NOT ?").all(thread.id) as { worktree_path: string }[]) add(row.worktree_path);
    for (const record of teamWorkspaces.list(this.db)) if (!executions.has(record.executionId)) add(record.path);
    for (const publication of teamWorkspaces.publications(this.db))
      if (!executions.has(publication.executionId)) {
        add(publication.scratchPath);
        add(publication.destinationPath);
      }
    for (const fork of teamForks.list(this.db))
      if (fork.destinationThreadId !== thread.id) {
        for (const file of fork.paths) add(file);
        add(fork.snapshot.rootPath);
      }
    for (const restore of teamRestores.list(this.db))
      if (restore.threadId !== thread.id) {
        for (const file of restore.paths) add(file);
        add(restore.sourcePath);
      }
    for (const move of teamMoves.list(this.db))
      if (move.threadId !== thread.id) {
        for (const item of move.paths) add(item.path);
        add(move.sourcePath);
      }
    return [...result];
  }

  /** Branch names only this owner's records could have produced; existence is checked at capture. */
  private ownedBranches(thread: Thread, deletedTaskIds: readonly string[]): string[] {
    const ordinary = `openorc/team-${thread.id}`;
    return [
      ordinary,
      ...teamMoves.forThread(this.db, thread.id).flatMap((move) => (move.publicationBranch?.startsWith(`${ordinary}-`) ? [move.publicationBranch] : [])),
      ...teamRestores.forThread(this.db, thread.id).map((restore) => `${ordinary}-restore-${restore.id}`),
      ...deletedTaskIds.map(teamTaskBranch),
    ];
  }

  /** Retention namespaces created for this owner's workspaces, publications and workspace operations. */
  private ownedRefPrefixes(thread: Thread, executions: ReadonlySet<string>): string[] {
    const fork = teamForks.byDestinationThread(this.db, thread.id);
    return [
      ...teamWorkspaces
        .list(this.db)
        .filter((record) => executions.has(record.executionId))
        .map((record) => `refs/openorc/teams/${record.id}/`),
      ...teamWorkspaces
        .publications(this.db)
        .filter((receipt) => executions.has(receipt.executionId))
        .map((receipt) => `refs/openorc/teams/${receipt.id}/`),
      ...(fork ? [`refs/openorc/forks/${fork.id}/`] : []),
      ...teamRestores.forThread(this.db, thread.id).map((restore) => `refs/openorc/restores/${restore.id}/`),
      ...teamMoves.forThread(this.db, thread.id).map((move) => `refs/openorc/moves/${move.id}/`),
      checkpointRefs(thread.id),
    ];
  }

  /** Exported patch files are known from their audit records, never guessed from names. */
  private ownedExports(deletedTaskIds: readonly string[]): string[] {
    if (!deletedTaskIds.length) return [];
    const exportsDir = path.join(this.dataDir, "exports");
    const rows = this.db
      .stmt(
        `SELECT json_extract(metadata,'$.path') AS file FROM audit_events WHERE action='review.export' AND resource_type='task'
      AND resource_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
      )
      .all(JSON.stringify(deletedTaskIds)) as { file: string | null }[];
    return [...new Set(rows.flatMap((row) => (row.file && path.isAbsolute(row.file) && pathContains(exportsDir, path.normalize(row.file)) ? [path.normalize(row.file)] : [])))];
  }

  /** Best-effort removal of now-empty per-execution folders inside the app data directory; never recursive. */
  private async tidy(receipt: TeamDeletionRecord): Promise<void> {
    const dataDir = await realpath(this.dataDir).catch(() => this.dataDir);
    for (const entry of receipt.entries) {
      let directory = path.dirname(entry.canonicalPath);
      while (pathContains(dataDir, directory) && path.relative(dataDir, directory).split(path.sep).length >= 2) {
        try {
          await rmdir(directory);
        } catch {
          break;
        }
        directory = path.dirname(directory);
      }
    }
  }
}
