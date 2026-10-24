import type { ProjectGit } from "@openorc/protocol";

export interface ProjectGitView {
  /** Null until it is known, and for Workspace, which never uses git. */
  state: ProjectGit | null;
  /** The folder is a repository, so its changes, checkpoints and commits can be read. */
  tracks: boolean;
  /** Worktrees and teams are known to be unavailable: they branch from a commit the folder doesn't have. */
  cannotBranch: boolean;
}

/** What git offers a project's folder, from the Mac's live `projects.git` read. Both apps decide branching from this. */
export function projectGitView(state: ProjectGit | null): ProjectGitView {
  return { state, tracks: state === "no_commits" || state === "ready", cannotBranch: state === "none" || state === "no_commits" };
}
