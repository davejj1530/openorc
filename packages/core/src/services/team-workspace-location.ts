import { orchestration, projects, teamContexts, teamForks, teamMoves, teamRestores, teamRuntime, teamWorkspaces, threads, type Db } from "@openorc/db";

/** The public branch is metadata; a local lead uses the checkout's actual branch. */
export function teamPublicationBranch(db: Db, threadId: string): string {
  const thread = threads.get(db, threadId);
  const branch = thread?.workspaceMode === "current" ? null : thread?.branch;
  const ordinary = "openorc/team-" + threadId;
  const moved = teamMoves.latestForThread(db, threadId)?.publicationBranch;
  const project = thread && projects.get(db, thread.projectId);
  const instance = orchestration.getInstance(db, threadId);
  const restore =
    instance && project
      ? teamRestores
          .forThread(db, threadId)
          .filter((item) => item.state === "applied" && item.instanceId === instance.id && item.sourcePath === project.rootPath)
          .sort((a, b) => (b.appliedContextId ? (teamContexts.get(db, b.appliedContextId)?.epoch ?? 0) : 0) - (a.appliedContextId ? (teamContexts.get(db, a.appliedContextId)?.epoch ?? 0) : 0))[0]
      : null;
  const restored = restore ? ordinary + "-restore-" + restore.id : null;
  if (branch && branch !== ordinary && branch !== moved && branch !== restored) throw new Error("The team's publication branch changed. Preserve its history before publishing.");
  return branch ?? restored ?? moved ?? ordinary;
}

/** Resolve the retained record that owns the current workspace pointer. */
export function teamWorkspaceLocation(db: Db, threadId: string): { path: string; baseSha: string; trackedTree: string; additionalTrackedTrees: string[] } {
  const thread = threads.get(db, threadId);
  const instance = orchestration.getInstance(db, threadId);
  const project = thread && projects.get(db, thread.projectId);
  if (!thread || !instance || !project || (thread.workspaceMode === "current" && thread.worktreePath) || (thread.workspaceMode === "worktree" && !thread.worktreePath))
    throw new Error("The team has no ready integrated lead workspace.");
  const currentPath = thread.worktreePath ?? project.rootPath;
  const moved = teamMoves.latestForThread(db, threadId);
  const ownedMove = moved?.instanceId === instance.id && moved.state === "applied" && moved.to === thread.workspaceMode && moved.appliedPath === currentPath ? moved : null;
  // Local executions reuse one physical path. Resolve only this instance's
  // newest history, never another team's record in the same shared checkout.
  const owned = db
    .stmt("SELECT w.execution_id FROM team_workspaces w JOIN team_executions e ON e.id=w.execution_id WHERE w.actor_id='lead' AND e.instance_id=? ORDER BY e.rowid DESC,w.rowid DESC")
    .all(instance.id) as { execution_id: string }[];
  const record = owned.map((row) => teamWorkspaces.get(db, row.execution_id, "lead")!).find((item) => item.path === currentPath);
  const moveEpoch = ownedMove?.appliedContextId ? teamContexts.get(db, ownedMove.appliedContextId)?.epoch : undefined;
  const recordContinuesMove =
    record &&
    moveEpoch !== undefined &&
    teamRuntime
      .get(db, record.executionId)
      ?.attempts.some((attempt) => attempt.actorId === "lead" && attempt.contextCheckpointId && (teamContexts.get(db, attempt.contextCheckpointId)?.epoch ?? 0) >= moveEpoch);
  // A later move can return to the same local path. Its context boundary
  // supersedes all earlier records there, regardless of wall-clock order.
  if (record && (!ownedMove || recordContinuesMove)) {
    if (record.state !== "ready" || record.setupState !== "completed" || !record.preparedTree || record.source.headSha !== thread.baseSha)
      throw new Error("The team has no ready integrated lead workspace. Resolve its retained workspace recovery before continuing.");
    return {
      path: record.path,
      baseSha: record.source.headSha,
      trackedTree: record.preparedTree,
      additionalTrackedTrees: [
        record.outputTree,
        ownedMove?.afterTree,
        ...teamWorkspaces
          .publications(db, record.executionId)
          .filter((receipt) => receipt.targetActorId === "lead" && receipt.state === "applied")
          .map((receipt) => receipt.afterTree),
      ].filter((tree): tree is string => Boolean(tree)),
    };
  }
  if (ownedMove) {
    const head = ownedMove.to === "current" ? ownedMove.destinationBefore?.headSha : ownedMove.source.headSha;
    if (!head || !ownedMove.afterTree || head !== thread.baseSha) throw new Error("The moved team's workspace HEAD no longer matches its retained movement.");
    return { path: currentPath, baseSha: head, trackedTree: ownedMove.afterTree, additionalTrackedTrees: [] as string[] };
  }
  const fork = teamForks.byDestinationThread(db, threadId);
  if (fork?.state === "applied" && fork.appliedPath && fork.appliedPath === thread.worktreePath && fork.snapshot.headSha === thread.baseSha) {
    return { path: fork.appliedPath, baseSha: fork.snapshot.headSha, trackedTree: fork.snapshot.treeSha, additionalTrackedTrees: [] as string[] };
  }
  const restore = teamRestores.latestForThread(db, threadId);
  if (restore?.instanceId === instance.id && restore.appliedPath && restore.appliedPath === thread.worktreePath && restore.before.headSha === thread.baseSha) {
    return { path: restore.appliedPath, baseSha: restore.before.headSha, trackedTree: restore.targetTree, additionalTrackedTrees: [] as string[] };
  }
  throw new Error("The team's current workspace is not retained by its execution, fork, restore or move. Preserve its files for recovery.");
}
