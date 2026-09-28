import { checkpoints, projects, threads, type Db } from "@openorc/db";
import { git } from "@openorc/git";
import type { TurnFileChanges } from "@openorc/protocol";
import { treeChanges } from "./tree-changes.js";

/**
 * What one thread turn changed: the checkpoint it saved against the one before it,
 * or against the thread's starting commit for the first. Immutable trees only, so a
 * later edit in the working directory never leaks into an earlier turn's card.
 */
export async function threadTurnChanges(db: Db, input: { threadId: string; checkpointId: string; includePatch?: boolean; paths?: string[] }): Promise<TurnFileChanges> {
  const thread = threads.get(db, input.threadId);
  const checkpoint = checkpoints.get(db, input.checkpointId);
  if (!thread || !checkpoint || checkpoint.threadId !== thread.id) throw new Error("This turn does not belong to the conversation.");
  const project = projects.get(db, thread.projectId);
  if (!project) throw new Error("The project for this checkpoint is unavailable.");
  const history = checkpoints.listForThread(db, thread.id);
  const index = history.findIndex((item) => item.id === checkpoint.id);
  let base: string | null = null;
  if (index > 0) base = history[index - 1]!.treeSha;
  else if (thread.baseSha) base = (await git(project.rootPath, ["rev-parse", `${thread.baseSha}^{tree}`])).stdout.trim();
  if (!base) throw new Error("The original comparison checkpoint is unavailable.");
  return treeChanges(project.rootPath, base, checkpoint.treeSha, { paths: input.paths, includePatch: input.includePatch });
}
