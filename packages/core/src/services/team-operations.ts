import { orchestration, projects, taskForwardings, tasks, teamDeletedThreads, teamDeletions, teamForks, teamMoves, teamRestores, threads, type Db } from "@openorc/db";

export interface TeamOperationReservation {
  assertCurrent(): void;
  release(): void;
}

/** Synchronous team admission fence, held before resolving any filesystem path. */
export class TeamOperationGuard {
  private readonly active = new Map<string, { token: object; done: Promise<void>; finish(): void }>();
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly quiescenceReason: (threadId: string) => string | null,
    private readonly changed: (threadId: string) => void,
  ) {}

  private notify(threadId: string): void {
    // A disconnected renderer must not strand a reservation that no caller can release.
    try {
      this.changed(threadId);
    } catch {
      /* Admission remains authoritative in core. */
    }
  }

  /** A hidden owner accepts work only through one of its saved tasks; a pending deletion fences everything. */
  assertAvailable(threadId: string, recoveryId?: string, options: { retainedTask?: boolean } = {}): void {
    if (this.closing) throw new Error("Team workspace operations are shutting down.");
    if (this.active.has(threadId)) throw new Error("Wait for the team's workspace operation to finish before starting another action.");
    if (tasks.list(this.db, { threadId }).some((task) => task.id !== recoveryId && taskForwardings.source(this.db, task.id)?.state === "preparing"))
      throw new Error("Finish the saved task handoff before starting new team work or changing its workspace.");
    if (teamDeletions.pending(this.db, threadId).some((operation) => operation.id !== recoveryId))
      throw new Error("Finish or cancel the team's retained deletion before starting new work or changing its workspace.");
    if (!options.retainedTask && teamDeletedThreads.has(this.db, threadId)) throw new Error("This conversation was deleted. Continue from one of its saved tasks.");
    if (teamForks.pendingForThread(this.db, threadId).some((operation) => operation.id !== recoveryId))
      throw new Error("Retry or cancel the team's retained fork before starting new work or changing its workspace.");
    if (teamRestores.pendingForThread(this.db, threadId).some((operation) => operation.id !== recoveryId))
      throw new Error("Retry or cancel the team's retained restore before starting new work or changing its workspace.");
    if (teamMoves.pendingForThread(this.db, threadId).some((operation) => operation.id !== recoveryId))
      throw new Error("Finish or cancel the team's retained move before starting new work or changing its workspace.");
  }

  reason(threadId: string, recoveryId?: string, options: { retainedTask?: boolean } = {}): string | null {
    try {
      this.assertAvailable(threadId, recoveryId, options);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return this.quiescenceReason(threadId);
  }

  reserve(threadId: string, recoveryId?: string, options: { retainedTask?: boolean } = {}): TeamOperationReservation {
    this.assertAvailable(threadId, recoveryId, options);
    const reason = this.quiescenceReason(threadId);
    if (reason) throw new Error(reason);
    const thread = threads.get(this.db, threadId);
    const instance = orchestration.getInstance(this.db, threadId);
    const project = thread && projects.get(this.db, thread.projectId);
    if (!thread || !instance || !project) throw new Error("This conversation no longer has a saved team and project.");
    const token = {};
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active.set(threadId, { token, done, finish });
    this.notify(threadId);
    return {
      assertCurrent: () => {
        if (this.active.get(threadId)?.token !== token) throw new Error("This workspace operation no longer owns the team.");
        const current = threads.get(this.db, threadId);
        const currentProject = projects.get(this.db, project.id);
        if (
          !current ||
          !currentProject ||
          current.projectId !== project.id ||
          currentProject.rootPath !== project.rootPath ||
          current.worktreePath !== thread.worktreePath ||
          current.workspaceMode !== thread.workspaceMode ||
          current.baseSha !== thread.baseSha ||
          orchestration.getInstance(this.db, threadId)?.id !== instance.id
        )
          throw new Error("The team's workspace changed during this operation. Reload before continuing.");
        const currentReason = this.quiescenceReason(threadId);
        if (currentReason) throw new Error(currentReason);
      },
      release: () => {
        const current = this.active.get(threadId);
        if (current?.token !== token) return;
        this.active.delete(threadId);
        current.finish();
        this.notify(threadId);
      },
    };
  }

  /** Let already-admitted operations release their writer leases before services close. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.active.values()].map((operation) => operation.done));
  }
}
