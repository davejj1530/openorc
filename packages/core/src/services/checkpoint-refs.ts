import { unpinAll } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { projectGit } from "./project-git.js";

/**
 * Where OpenOrc pins the trees it saves, so `git gc` never removes a conversation's checkpoints or a task's
 * snapshots. Each tree is pinned once per owner; deleting the owner deletes its prefix.
 */
export const checkpointRefs = (threadId: string) => `refs/openorc/checkpoints/${threadId}/`;
export const snapshotRefs = (taskId: string) => `refs/openorc/snapshots/${taskId}/`;

/** Deletes an owner's pins. A folder without git has none, and one inside another repository must not reach it. */
export async function unpinProjectRefs(project: Pick<Project, "id" | "rootPath">, prefix: string): Promise<void> {
  if ((await projectGit(project)) !== "none") await unpinAll(project.rootPath, prefix);
}
