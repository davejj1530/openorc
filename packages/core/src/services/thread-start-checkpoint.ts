import { realpath } from "node:fs/promises";
import { checkpoints, orchestration, type Db } from "@openorc/db";
import { diffStat, pinObject, treeHash } from "@openorc/git";
import { checkpointRefs } from "./checkpoint-refs.js";
import { projectGit } from "./project-git.js";
import type { StartRunInput } from "./run-types.js";

/**
 * Save the working files before the first provider can edit them, under its workspace lease.
 * Turn zero has no run, so it supplies the first diff and Undo without creating a turn card.
 * Existing histories keep their original order; teams own their own starting trees.
 */
export async function captureThreadStart(db: Db, input: StartRunInput, cwd: string): Promise<void> {
  const { thread } = input.scope;
  if (!thread || input.teamAttemptId || orchestration.getInstance(db, thread.id)) return;
  if (checkpoints.listForThread(db, thread.id).length || (await projectGit(input.project)) === "none") return;
  try {
    const [tree, stat, root] = await Promise.all([treeHash(cwd), diffStat(cwd, thread.baseSha), realpath(cwd)]);
    await pinObject(cwd, `${checkpointRefs(thread.id)}${tree}`, tree);
    checkpoints.insert(db, { threadId: thread.id, runId: null, turn: 0, treeSha: tree, diffStat: stat, root, note: "Starting files" });
  } catch (error) {
    throw new Error(`Could not save the starting files for Undo: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
