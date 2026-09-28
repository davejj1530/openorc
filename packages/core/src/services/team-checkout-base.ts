import { realpath } from "node:fs/promises";
import path from "node:path";
import { orchestration, projects, teamContexts, teamForks, teamMoves, teamRestores, teamWorkspaces, threads, type Db } from "@openorc/db";

/**
 * The checkout's captured files when this workspace became independent.
 * A commit tree alone omits the dirty/untracked input that teams inherit.
 * Follow immutable source captures, never a later turn's prepared/output tree.
 */
export async function teamCheckoutBase(db: Db, threadId: string, workspacePath: string, localTree?: string, throughEpoch = Infinity): Promise<string | null> {
  const physical = (value: string) => realpath(value).catch(() => path.resolve(value));
  const visited = new Set<string>();
  const resolve = async (ownerId: string, candidate: string, capturedLocalTree?: string): Promise<string | null> => {
    const thread = threads.get(db, ownerId);
    const instance = orchestration.getInstance(db, ownerId);
    const project = thread && projects.get(db, thread.projectId);
    if (!thread || !instance || !project) return null;
    const target = await physical(candidate),
      root = await physical(project.rootPath);
    const key = JSON.stringify([instance.id, target]);
    if (visited.has(key)) throw new Error("The team's retained checkout lineage contains a cycle. Its files were preserved.");
    visited.add(key);
    if (target === root) {
      // A fork of a local turn includes work brought into the checkout by the
      // team, even if its source later moves out again. A reply cutoff observes
      // only the local move that preceded that turn's context boundary.
      const origin = teamMoves
        .forThread(db, ownerId)
        .filter((item) => item.instanceId === instance.id && item.state === "applied" && item.to === "current" && item.appliedContextId)
        .map((item) => ({ item, epoch: teamContexts.get(db, item.appliedContextId!)?.epoch ?? Infinity }))
        .filter((value) => value.epoch <= throughEpoch)
        .sort((a, b) => b.epoch - a.epoch)[0]?.item;
      return origin?.destinationBefore?.treeSha ?? capturedLocalTree ?? null;
    }
    const rows = db
      .stmt("SELECT w.execution_id FROM team_workspaces w JOIN team_executions e ON e.id=w.execution_id WHERE e.instance_id=? AND w.actor_id='lead' ORDER BY e.rowid DESC")
      .all(instance.id) as { execution_id: string }[];
    for (const row of rows) {
      const record = teamWorkspaces.get(db, row.execution_id, "lead")!;
      if ((await physical(record.path)) !== target) continue;
      return (await physical(record.source.rootPath)) === root ? record.source.treeSha : resolve(ownerId, record.source.rootPath);
    }
    for (const move of teamMoves.forThread(db, ownerId)) {
      if (move.instanceId === instance.id && move.state === "applied" && move.to === "worktree" && move.appliedPath && (await physical(move.appliedPath)) === target)
        return move.publication?.afterTree ?? null;
    }
    for (const restore of teamRestores.forThread(db, ownerId)) {
      if (restore.instanceId !== instance.id || restore.state !== "applied" || !restore.appliedPath || (await physical(restore.appliedPath)) !== target) continue;
      return (await physical(restore.sourcePath)) === root ? restore.before.treeSha : resolve(ownerId, restore.sourcePath);
    }
    const fork = teamForks.byDestinationThread(db, ownerId);
    if (fork?.projectId === project.id && fork.appliedPath && (await physical(fork.appliedPath)) === target) {
      // New receipts carry this proof after the source owner is deleted.
      // Older receipts may lack it; use a commit merge base conservatively.
      return fork.checkoutBaseTree ?? null;
    }
    return null;
  };
  return resolve(threadId, workspacePath, localTree);
}
