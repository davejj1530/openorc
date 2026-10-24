import { WORKSPACE_ID, type Project } from "@openorc/protocol";

/** A place a thread lives: Workspace, or one of the Mac's projects. */
export type ProjectChoice = Pick<Project, "id" | "name">;

/** Workspace first, then the Mac's projects in the order it lists them, as the sidebar and New thread order them. */
export function projectChoices(projects: readonly ProjectChoice[] | undefined): ProjectChoice[] {
  return [{ id: WORKSPACE_ID, name: "Workspace" }, ...(projects ?? []).map(({ id, name }) => ({ id, name }))];
}
