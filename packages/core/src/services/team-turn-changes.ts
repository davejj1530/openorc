import { checkpoints, projects, teamRuntime, teamWorkspaces, type Db } from "@openorc/db";
import type { TeamTurnChanges } from "@openorc/protocol";
import { treeChanges } from "./tree-changes.js";

/** Reviews immutable checkpoint trees. Never captures or diffs the changing working directory. */
export async function teamTurnChanges(db: Db, input: { threadId: string; executionId: string; turnId: string; includePatch?: boolean; paths?: string[] }): Promise<TeamTurnChanges> {
  const execution = teamRuntime.get(db, input.executionId);
  if (!execution || execution.threadId !== input.threadId) throw new Error("This turn does not belong to the conversation.");
  const attempt = execution.attempts.find((item) => item.id === input.turnId);
  const checkpoint = attempt?.snapshotId ? checkpoints.get(db, attempt.snapshotId) : null;
  if (!attempt || attempt.state !== "closed" || !attempt.changedFiles?.length || !checkpoint || checkpoint.threadId !== input.threadId || checkpoint.runId !== attempt.runId) {
    throw new Error("This turn has no saved file changes to review.");
  }
  const history = checkpoints.listForThread(db, input.threadId);
  const index = history.findIndex((item) => item.id === checkpoint.id);
  let base = index > 0 ? history[index - 1]!.treeSha : null;
  if (!base) {
    const executions = db.stmt("SELECT id FROM team_executions WHERE instance_id=? ORDER BY created_at,rowid").all(execution.instanceId) as { id: string }[];
    for (const row of executions) {
      const workspace = teamWorkspaces.get(db, row.id, "lead");
      if (workspace) {
        base = workspace.preparedTree ?? workspace.source.treeSha;
        break;
      }
    }
  }
  if (!base) throw new Error("The original comparison checkpoint is unavailable.");
  const project = projects.get(db, execution.projectId);
  if (!project) throw new Error("The project for this checkpoint is unavailable.");
  const paths = input.paths ?? attempt.changedFiles;
  if (!paths.length || paths.some((path) => !attempt.changedFiles!.includes(path))) throw new Error("Select files listed in this turn’s change card.");
  const changes = await treeChanges(project.rootPath, base, checkpoint.treeSha, { paths, includePatch: input.includePatch });
  return { ...changes, attribution: "shared-checkpoint", note: "Changes between saved workspace checkpoints. Concurrent edits may be included; this is not exclusive authorship by this member." };
}
