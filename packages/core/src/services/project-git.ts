import { gitState } from "@openorc/git";
import { WORKSPACE_ID, type Project, type ProjectGit } from "@openorc/protocol";

type ProjectFolder = Pick<Project, "id" | "name" | "rootPath">;

/**
 * What git offers the project's folder right now. It is read live, so a folder that gains git or its first commit
 * gets the features without being added again. Workspace folders never use git, even inside a repository.
 */
export function projectGit(project: Pick<Project, "id" | "rootPath">): Promise<ProjectGit> {
  return project.id === WORKSPACE_ID ? Promise.resolve("none") : gitState(project.rootPath);
}

/** Change tracking, checkpoints and review need a repository; its first commit can come later. */
export async function assertRepository(project: ProjectFolder): Promise<void> {
  if ((await projectGit(project)) === "none") throw new Error(`${project.name} isn't a git repository yet, so OpenOrc can't track or review its changes.`);
}

/** Worktrees and teams branch from a commit. Null once the project has one, otherwise what it still needs. */
export async function branchingBlocker(project: ProjectFolder): Promise<string | null> {
  const state = await projectGit(project);
  if (state === "ready") return null;
  return state === "none"
    ? `${project.name} isn't a git repository yet. Worktrees and teams need git and a first commit.`
    : `${project.name} has no commits yet. Worktrees and teams need a first commit.`;
}

export async function assertCanBranch(project: ProjectFolder): Promise<void> {
  const blocker = await branchingBlocker(project);
  if (blocker) throw new Error(blocker);
}
