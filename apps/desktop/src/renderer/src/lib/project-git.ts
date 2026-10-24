import { projectGitView, type ProjectGitView } from "@openorc/client";
import { WORKSPACE_ID, type ProjectGit } from "@openorc/protocol";
import { useRpc } from "./client";

/**
 * What git offers a project's folder, read live because git can be set up at any time. Until it is known, git
 * reads stay off so a folder without git never shows their errors, and choices stay on so a ready project never flickers.
 */
export function useProjectGit(projectId: string | null | undefined): ProjectGitView {
  const id = projectId ?? "";
  const query = useRpc("projects.git", { id }, { enabled: Boolean(id) && id !== WORKSPACE_ID });
  return projectGitView(query.data ?? null);
}

/** Why worktrees or teams are unavailable, for the places that already explain a disabled choice. */
export function branchingReason(state: ProjectGit | null, feature: "Worktrees" | "Teams"): string | null {
  if (state === "none") return `${feature} need git and a first commit.`;
  return state === "no_commits" ? `${feature} need a first commit.` : null;
}
