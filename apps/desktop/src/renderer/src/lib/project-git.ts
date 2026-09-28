import { WORKSPACE_ID, type ProjectGit } from "@openorc/protocol";
import { useRpc } from "./query";

export interface ProjectGitView {
  /** Null until it is known, and for Workspace, which never uses git. */
  state: ProjectGit | null;
  /** The folder is a repository, so its changes, checkpoints and commits can be read. */
  tracks: boolean;
  /** Worktrees and teams are known to be unavailable: they branch from a commit the folder doesn't have. */
  cannotBranch: boolean;
}

/**
 * What git offers a project's folder, read live because git can be set up at any time. Until it is known, git
 * reads stay off so a folder without git never shows their errors, and choices stay on so a ready project never flickers.
 */
export function useProjectGit(projectId: string | null | undefined): ProjectGitView {
  const id = projectId ?? "";
  const query = useRpc("projects.git", { id }, { enabled: Boolean(id) && id !== WORKSPACE_ID });
  return projectGitView(query.data ?? null);
}

export function projectGitView(state: ProjectGit | null): ProjectGitView {
  return { state, tracks: state === "no_commits" || state === "ready", cannotBranch: state === "none" || state === "no_commits" };
}

/** Why worktrees or teams are unavailable, for the places that already explain a disabled choice. */
export function branchingReason(state: ProjectGit | null, feature: "Worktrees" | "Teams"): string | null {
  if (state === "none") return `${feature} need git and a first commit.`;
  return state === "no_commits" ? `${feature} need a first commit.` : null;
}
