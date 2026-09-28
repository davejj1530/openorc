import { realpath } from "node:fs/promises";
import { checkpoints, runCosts, runs, snapshots, tasks, threads, type Db, type LedgerWriter } from "@openorc/db";
import { diffStat, pinObject, treeHash, worktree } from "@openorc/git";
import type { Project, Run, Task, Thread } from "@openorc/protocol";
import type { OpenOrcMcpServer } from "@openorc/mcp";
import { checkpointRefs, snapshotRefs } from "./checkpoint-refs.js";
import { projectGit } from "./project-git.js";
import type { McpAppService } from "./mcp-apps.js";
import type { Logger } from "../transport.js";
import { capturedTurnOutcome, providerTurnStatus, type CompletedTurn, type LiveRun, type Notification, type RunHooks, type RunScope, type TurnSettledOutcome } from "./run-types.js";

/** The provider forgot the session: the words its CLIs use when a resume finds nothing. */
export function isSessionLost(message: string | null): boolean {
  if (!message) return false;
  return /no conversation found|\b(session|thread|rollout)\b.*\b(not found|does not exist|unknown|missing|could not be (found|loaded))|\b(not found|unknown|missing)\b.*\b(session|thread)\b/i.test(
    message,
  );
}

/** Captures completed work and releases the process/lease after its event barrier. */
interface RunSettlementDependencies {
  db: Db;
  ledger: LedgerWriter;
  log: Logger;
  hooks: Pick<RunHooks, "captureTeamTree" | "onThreadTurn" | "onRunFinished">;
  mcp: () => Promise<OpenOrcMcpServer>;
  mcpApps: McpAppService;
  detach: (runId: string) => void;
  isClosing: () => boolean;
  invalidate: (keys: string[]) => void;
  keysFor: (scope: RunScope) => string[];
  notifyFor: (scope: RunScope, kind: Notification["kind"], title: string, body: string) => void;
  scopeTitle: (scope: RunScope) => string;
  turnSettled: (run: Run, scope: RunScope, project: Project, outcome: TurnSettledOutcome) => void;
  armIdle: (entry: LiveRun) => void;
  refreshDiffs: (entry: LiveRun, project: Project) => void;
  disarmIdle: (runId: string) => void;
  endDiffRefresh: (runId: string, ended?: { entry: LiveRun; project: Project }) => void;
  denyApprovals: (runId: string) => void;
}

export class RunSettlement {
  constructor(private readonly deps: RunSettlementDependencies) {}

  /**
   * What this turn cost. Providers report the session's running total, so the turn's share is the difference from
   * the previous report: this run's last turn, or for a resumed session, the last total an earlier run recorded.
   */
  private costSinceLastReport(entry: LiveRun, reported: number | undefined): number {
    if (reported === undefined) return 0;
    const sessionId = entry.usage?.costUsd === undefined ? runs.get(this.deps.db, entry.run.id)?.externalSessionId : null;
    const before = entry.usage?.costUsd ?? (sessionId ? runCosts.previousSessionCost(this.deps.db, sessionId, entry.run.id) : 0);
    return Math.max(0, reported - before);
  }

  async completeTurn(entry: LiveRun, project: Project, turn: CompletedTurn): Promise<void> {
    entry.turns += 1;
    this.deps.refreshDiffs(entry, project);
    if (turn.usage) {
      const spent = this.costSinceLastReport(entry, turn.usage.costUsd);
      entry.usage = { ...entry.usage, ...turn.usage };
      if (spent > 0 && entry.scope.task) tasks.addCost(this.deps.db, entry.scope.task.id, spent);
    }
    // Providers can report the cause before the terminal event, whose result
    // is often empty. Keep that cause for settlement, notifications and exit.
    if (turn.status !== "success" && turn.status !== "cancelled") entry.failed ??= turn.resultText ?? `turn ended with ${turn.status}`;
    runs.update(this.deps.db, entry.run.id, { usage: entry.usage, resultText: turn.resultText ?? entry.reply });

    if (entry.scope.comment) {
      entry.busy = false;
      this.deps.turnSettled(entry.run, entry.scope, project, { status: providerTurnStatus(turn, entry.failed), snapshotId: null, error: entry.failed });
      entry.handle.close();
    } else if (entry.scope.task) {
      await this.completeTaskTurn(entry, project, turn, entry.scope.task);
    } else {
      await this.completeThreadTurn(entry, project, turn, entry.scope.thread);
    }
  }

  private async completeTaskTurn(entry: LiveRun, project: Project, turn: CompletedTurn, task: Task): Promise<void> {
    const capture = await this.snapshot(entry, task, project);
    entry.busy = false;
    this.deps.turnSettled(entry.run, entry.scope, project, capturedTurnOutcome(turn, entry.failed, capture));
    this.deps.invalidate([...this.deps.keysFor(entry.scope), `snapshots:${task.id}`, `diff:${task.id}`, `log:${task.id}`, `projectgit:${project.id}`]);
    // A task run is one unit of work. Follow-ups resume the closed session.
    entry.handle.close();
  }

  private async completeThreadTurn(entry: LiveRun, project: Project, turn: CompletedTurn, thread: Thread): Promise<void> {
    const capture = await this.checkpoint(entry, project, thread, entry.workspaceLease.paths[0]!);
    entry.busy = false;
    this.deps.armIdle(entry);
    this.deps.turnSettled(entry.run, entry.scope, project, capturedTurnOutcome(turn, entry.failed, capture));
    threads.touch(this.deps.db, thread.id);
    // An agent may have set up git or made the first commit, which turns on more of the project.
    this.deps.invalidate([...this.deps.keysFor(entry.scope), `checkpoints:${thread.id}`, `threaddiff:${thread.id}`, `projectgit:${project.id}`]);
    const reply = turn.resultText ?? entry.reply;
    this.deps.hooks.onThreadTurn(thread, { prompt: entry.prompt, reply });
    if (turn.status === "success") this.deps.notifyFor(entry.scope, "finished", thread.title, reply ? reply.replace(/\s+/g, " ").slice(0, 140) : "The agent finished its turn.");
    else if (turn.status !== "cancelled") this.deps.notifyFor(entry.scope, "error", thread.title, entry.failed ?? "The turn failed.");
  }

  private async captureTree(entry: LiveRun, cwd: string, refs: string): Promise<string> {
    const team = await this.deps.hooks.captureTeamTree?.(entry.run.id, cwd, entry.workspaceLease);
    if (team) return team;
    const tree = await treeHash(cwd);
    await pinObject(cwd, `${refs}${tree}`, tree);
    return tree;
  }

  private async snapshot(entry: LiveRun, task: Task, project: Project): Promise<{ snapshotId: string | null; error: string | null }> {
    if (task.workspaceMode !== "current" && !task.worktreePath) return { snapshotId: null, error: "This task has no workspace to snapshot." };
    const cwd = entry.workspaceLease.paths[0];
    if (!cwd) return { snapshotId: null, error: "This task has no workspace to snapshot." };
    try {
      if ((await projectGit(project)) === "none") return { snapshotId: null, error: null };
      const [tree, stat] = await Promise.all([this.captureTree(entry, cwd, snapshotRefs(task.id)), diffStat(cwd, task.baseSha)]);
      return { snapshotId: snapshots.insert(this.deps.db, { taskId: task.id, runId: entry.run.id, turn: entry.turns, treeSha: tree, diffStat: stat }).id, error: null };
    } catch (e) {
      const error = `Snapshot failed: ${e instanceof Error ? e.message : String(e)}`;
      this.deps.log.warn(error);
      return { snapshotId: null, error };
    }
  }

  private async checkpoint(entry: LiveRun, project: Project, thread: Thread, cwd: string): Promise<{ snapshotId: string | null; error: string | null }> {
    try {
      if ((await projectGit(project)) === "none") return { snapshotId: null, error: null };
      const [tree, stat, root] = await Promise.all([this.captureTree(entry, cwd, checkpointRefs(thread.id)), diffStat(cwd, thread.baseSha), realpath(cwd)]);
      const last = checkpoints.listForThread(this.deps.db, thread.id).at(-1);
      if (last?.treeSha === tree && last.root === root) return { snapshotId: last.id, error: null };
      return { snapshotId: checkpoints.insert(this.deps.db, { threadId: thread.id, runId: entry.run.id, turn: entry.turns, treeSha: tree, diffStat: stat, root }).id, error: null };
    } catch (e) {
      const error = `Checkpoint failed: ${e instanceof Error ? e.message : String(e)}`;
      this.deps.log.warn(error);
      return { snapshotId: null, error };
    }
  }

  private failureReason(entry: LiveRun): string {
    if (entry.failed) return entry.failed;
    const said = entry.stderr.filter((l) => l.trim().length > 0 && !/^\s*(warn|debug)/i.test(l));
    if (said.length > 0) return said.slice(-3).join("\n");
    return entry.started ? "The agent exited before finishing its turn." : "The agent exited before starting a session.";
  }

  async onExit(entry: LiveRun, project: Project): Promise<void> {
    // The process is gone; its tool address goes with it.
    void this.deps
      .mcp()
      .then((server) => server.revoke(entry.run.id))
      .catch(() => undefined);
    this.deps.disarmIdle(entry.run.id);
    this.deps.endDiffRefresh(entry.run.id, { entry, project });
    this.deps.denyApprovals(entry.run.id);
    const current = runs.get(this.deps.db, entry.run.id);
    const { state, error } = this.exitResult(entry, current?.state);
    runs.update(this.deps.db, entry.run.id, { state, endedAt: Date.now(), usage: entry.usage, ...(error ? { error } : {}) });
    this.notifyInitialFailure(entry, error);
    const task = entry.scope.task;
    if (task?.worktreePath) await worktree.unlock(project.rootPath, task.worktreePath).catch(() => undefined);
    if (task) this.reviewFinishedTask(entry, task);
    this.deps.ledger.flush();
    if (entry.turns === 0 || entry.busy) this.deps.turnSettled(entry.run, entry.scope, project, { status: state === "cancelled" ? "cancelled" : "error", snapshotId: null, error });
    this.deps.detach(entry.run.id);
    this.deps.mcpApps.closeRun(entry.run.id);
    entry.workspaceLease.release();
    this.deps.invalidate(this.deps.keysFor(entry.scope));
    // Distil the run into memory and report task results to their thread, once its events are on disk.
    this.notifyFinished(entry, project);
  }

  private exitResult(entry: LiveRun, current: Run["state"] | undefined): { state: Run["state"]; error: string | null } {
    const cancelled = current === "cancelled" || (entry.closingRequested && entry.busy && !entry.failed);
    if (entry.failed || ((entry.turns === 0 || entry.busy) && !cancelled)) return { state: "error", error: this.failureReason(entry) };
    if (cancelled) return { state: "cancelled", error: null };
    if (current === "running" || current === "starting") return { state: "success", error: null };
    return { state: current ?? "success", error: null };
  }

  private notifyInitialFailure(entry: LiveRun, error: string | null): void {
    if (!error || entry.turns !== 0) return;
    this.deps.log.warn(`run ${entry.run.id} failed: ${error}`);
    const body = isSessionLost(error) ? "The provider no longer has this session. Start a fresh one from the thread." : (error.split("\n")[0] ?? "The run failed.");
    this.deps.notifyFor(entry.scope, "error", this.deps.scopeTitle(entry.scope), body);
  }

  private reviewFinishedTask(entry: LiveRun, task: Task): void {
    const fresh = tasks.get(this.deps.db, task.id);
    if (fresh && fresh.status === "in_progress" && entry.turns > 0) tasks.update(this.deps.db, task.id, { status: "review" });
  }

  private notifyFinished(entry: LiveRun, project: Project): void {
    const finished = runs.get(this.deps.db, entry.run.id);
    const task = entry.scope.task;
    if (!finished || entry.scope.comment || (entry.turns === 0 && !task) || this.deps.isClosing()) return;
    if (task) {
      const body = finished.resultText ? finished.resultText.replace(/\s+/g, " ").slice(0, 140) : "The task finished and reported back.";
      this.deps.notifyFor(entry.scope, "task", task.title, body);
    }
    this.deps.hooks.onRunFinished(finished, entry.scope, project);
  }
}
