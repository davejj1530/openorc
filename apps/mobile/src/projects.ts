import { WORKSPACE_ID, type Project } from "@openorc/protocol";

/** A place a thread lives: Workspace, or one of the Mac's projects. */
export interface ProjectChoice {
  id: string;
  name: string;
  /**
   * A worktree can branch here. Workspace never does. A project needs the default branch the Mac found in it: a folder
   * without git or without a first commit has none, which is all a phone can see of the git state the desktop reads.
   */
  canBranch: boolean;
}

/** Workspace first, then the Mac's projects in the order it lists them, as the sidebar and New thread order them. */
export function projectChoices(projects: readonly Pick<Project, "id" | "name" | "defaultBranch">[] | undefined): ProjectChoice[] {
  return [{ id: WORKSPACE_ID, name: "Workspace", canBranch: false }, ...(projects ?? []).map(({ id, name, defaultBranch }) => ({ id, name, canBranch: defaultBranch !== null }))];
}
