import { WORKSPACE_ID, type Project, type Space, type SpaceProject } from "@openorc/protocol";

/**
 * A place a thread lives: Workspace, one of the Mac's projects, or a project only OpenOrc Cloud has (`cloud`, with the
 * space it is in), whose threads start there without the Mac.
 */
export type ProjectChoice = Pick<Project, "id" | "name"> & { cloud?: { spaceId: string } };

/** Workspace first, then the Mac's projects in the order it lists them, as the sidebar and New thread order them. */
export function projectChoices(projects: readonly ProjectChoice[] | undefined): ProjectChoice[] {
  return [{ id: WORKSPACE_ID, name: "Workspace" }, ...(projects ?? []).map(({ id, name }) => ({ id, name }))];
}

/**
 * A space's projects as New thread offers them, in the space's order, as Home groups them: one with a folder on this
 * Mac starts there, under the Mac's id; one only OpenOrc Cloud has starts there. Personal leads with the Mac's Workspace.
 */
export function spaceChoices(space: Space, projects: readonly SpaceProject[]): ProjectChoice[] {
  const choices = projects.map(({ key, name, localProjectId }): ProjectChoice => (localProjectId ? { id: localProjectId, name } : { id: key, name, cloud: { spaceId: space.id } }));
  return space.kind === "personal" ? [{ id: WORKSPACE_ID, name: "Workspace" }, ...choices] : choices;
}
