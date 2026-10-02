import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projects, tasks, threads, type Db } from "@openorc/db";
import { WORKSPACE_ID, type AgentEvent, type Project } from "@openorc/protocol";
import { overlaps } from "./workspace-writers.js";
import type { Logger } from "../transport.js";
import { occupied, working, type LiveRun, type RunHooks } from "./run-types.js";

/** Workspace leases hold resolved paths; records may not. Compare checkouts by the directory they resolve to. */
function canonicalDirectory(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** While changes keep arriving, the working-tree diffs on screen refresh at most this often. */
const DIFF_REFRESH_MS = 1000;
/** While a run works, its diffs also refresh this often: subagents, background tasks and unrecognized tools change files too. */
const WORKING_DIFF_REFRESH_MS = 8000;

/** Owns the live-run map, idle timers and diff refresh windows. */
interface RunLiveDependencies {
  db: Db;
  isClosing: () => boolean;
  isAgentUpdateReserved: () => boolean;
  closeAndWait: (runId: string) => Promise<void>;
  hooks: Pick<RunHooks, "idleTimeoutMs">;
  emit: (event: AgentEvent) => void;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: LiveRun["scope"]) => string[];
  log: Logger;
}

export class RunLive {
  private readonly live = new Map<string, LiveRun>();
  private readonly pendingCompactions = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diffRefreshes = new Map<string, { ticker: ReturnType<typeof setInterval>; window: ReturnType<typeof setTimeout> | null; owed: boolean }>();

  constructor(private readonly deps: RunLiveDependencies) {}

  get entries(): ReadonlyMap<string, LiveRun> {
    return this.live;
  }

  get compactions(): ReadonlyMap<string, Promise<void>> {
    return this.pendingCompactions;
  }

  /** A compacting process stays busy until its provider call settles; sends wait on that same promise. */
  compact(runId: string): Promise<void> {
    if (this.deps.isAgentUpdateReserved()) return Promise.reject(new Error("An agent update is running. Try again when it finishes."));
    if (this.deps.isClosing()) return Promise.reject(new Error("OpenOrc is closing."));
    const existing = this.pendingCompactions.get(runId);
    if (existing) return existing;
    const entry = this.live.get(runId);
    if (!entry) return Promise.reject(new Error(`run ${runId} is not live`));
    if (entry.busy) return Promise.reject(new Error("Wait for the current turn to finish before compacting."));
    this.disarmIdle(runId);
    entry.busy = true;
    this.deps.invalidate(this.deps.keysFor(entry.scope));
    const pending = entry.handle
      .compact()
      .then(() => {
        this.deps.emit({
          type: "message.completed",
          runId,
          ts: Date.now(),
          messageId: `compact-${randomUUID()}`,
          role: "system",
          text: "Context compacted. The agent continues from a summary of the conversation so far.",
        });
      })
      .finally(() => {
        this.pendingCompactions.delete(runId);
        entry.busy = false;
        this.armIdle(entry);
        this.deps.invalidate(this.deps.keysFor(entry.scope));
      });
    this.pendingCompactions.set(runId, pending);
    return pending;
  }

  attach(entry: LiveRun): void {
    this.live.set(entry.run.id, entry);
  }

  detach(runId: string): void {
    this.live.delete(runId);
  }

  stopRefreshes(): void {
    for (const runId of [...this.idleTimers.keys()]) this.disarmIdle(runId);
    for (const runId of [...this.diffRefreshes.keys()]) this.endDiffRefresh(runId);
  }

  armIdle(entry: LiveRun): void {
    const runId = entry.run.id;
    this.disarmIdle(runId);
    const timeout = this.deps.hooks.idleTimeoutMs?.() ?? null;
    if (!timeout || entry.scope.task || this.deps.isClosing() || occupied(entry)) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(runId);
      const live = this.live.get(runId);
      if (!live || occupied(live) || live.exiting || live.closingRequested || this.pendingCompactions.has(runId) || this.deps.isClosing()) return;
      this.deps.log.info(`run ${runId} idle for ${Math.round(timeout / 1000)}s; closing its process, the session resumes on the next message`);
      void this.deps.closeAndWait(runId).catch((error) => this.deps.log.warn(`run ${runId} idle close: ${error instanceof Error ? error.message : String(error)}`));
    }, timeout);
    timer.unref();
    this.idleTimers.set(runId, timer);
  }

  async yieldIdle(paths: readonly string[]): Promise<boolean> {
    const idle = [...this.live.values()].filter(
      (entry) =>
        entry.scope.thread && !entry.team && !occupied(entry) && !entry.exiting && !entry.closingRequested && !this.pendingCompactions.has(entry.run.id) && overlaps(entry.workspaceLease.paths, paths),
    );
    if (idle.length === 0) return false;
    for (const entry of idle) {
      const started = Date.now();
      this.deps.log.info(`run ${entry.run.id} yields ${entry.workspaceLease.paths.join(", ")} to new work; its session resumes on the next message`);
      await this.deps.closeAndWait(entry.run.id);
      this.deps.log.info(`run ${entry.run.id} yielded in ${Date.now() - started} ms`);
    }
    return true;
  }

  watchDiffs(entry: LiveRun, project: Project): void {
    if (entry.scope.comment || project.id === WORKSPACE_ID) return;
    const ticker = setInterval(() => {
      if (working(entry)) this.refreshDiffs(entry, project);
    }, WORKING_DIFF_REFRESH_MS);
    ticker.unref();
    this.diffRefreshes.set(entry.run.id, { ticker, window: null, owed: false });
  }

  refreshDiffs(entry: LiveRun, project: Project): void {
    const state = this.diffRefreshes.get(entry.run.id);
    if (!state) return;
    if (state.window) {
      state.owed = true;
      return;
    }
    this.deps.invalidate(this.diffKeys(entry, project));
    state.window = setTimeout(() => {
      state.window = null;
      if (!state.owed) return;
      state.owed = false;
      this.refreshDiffs(entry, project);
    }, DIFF_REFRESH_MS);
    state.window.unref();
  }

  endDiffRefresh(runId: string, ended?: { entry: LiveRun; project: Project }): void {
    const state = this.diffRefreshes.get(runId);
    if (!state) return;
    clearInterval(state.ticker);
    if (state.window) clearTimeout(state.window);
    this.diffRefreshes.delete(runId);
    if (ended && (state.owed || working(ended.entry))) this.deps.invalidate(this.diffKeys(ended.entry, ended.project));
  }

  private diffKeys(entry: LiveRun, project: Project): string[] {
    const lease = entry.workspaceLease.paths[0];
    if (!lease) return [];
    const cwd = canonicalDirectory(lease);
    const root = projects.get(this.deps.db, project.id)?.rootPath ?? project.rootPath;
    const here = (dir: string) => canonicalDirectory(dir) === cwd;
    const threadKeys = threads.list(this.deps.db, { projectId: project.id, filter: "active" }).flatMap((thread) => (here(thread.worktreePath ?? root) ? [`threaddiff:${thread.id}`] : []));
    const taskKeys = tasks
      .list(this.deps.db, { projectId: project.id, statuses: ["backlog", "in_progress", "review"] })
      .flatMap((task) => (here(task.worktreePath ?? root) ? [`diff:${task.id}`] : []));
    const own = [...(entry.scope.thread ? [`threaddiff:${entry.scope.thread.id}`] : []), ...(entry.scope.task ? [`diff:${entry.scope.task.id}`] : [])];
    return [...new Set([...own, ...threadKeys, ...taskKeys, ...(here(root) ? [`projectdiff:${project.id}`] : [])])];
  }

  disarmIdle(runId: string): void {
    const timer = this.idleTimers.get(runId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(runId);
  }
}
