import { WORKSPACE_ID, type Space, type SpaceProject } from "@openorc/protocol";
import type { ProjectChoice } from "../projects";

/** Whose threads Home's lists ask for, and what they need to draw them. */
export interface ListScope {
  /** What every list call carries: this Mac's projects, or the space, whose list the Mac then answers as for its own window. */
  asks: { projectIds: string[] } | { spaceId: string };
  /** This Mac's projects in scope, which the count of resolved threads is asked by. */
  localIds: string[];
  /** Every project's name by the ids a thread may carry for it. */
  names: ReadonlyMap<string, string>;
}

/** The Mac alone: Workspace and its projects, as Home lists a Mac with no account. */
export function macScope(choices: readonly ProjectChoice[]): ListScope {
  const localIds = choices.map((project) => project.id).sort();
  return { asks: { projectIds: localIds }, localIds, names: new Map(choices.map(({ id, name }) => [id, name])) };
}

/**
 * A space: its projects, whether they have a folder on this Mac, live on OpenOrc Cloud alone, or both, each named
 * under every id it has. Personal also holds the Mac's Workspace.
 */
export function spaceScope(space: Space, projects: readonly SpaceProject[] | undefined): ListScope {
  const names = new Map<string, string>();
  const localIds: string[] = [];
  for (const project of projects ?? []) {
    for (const id of [project.key, project.localProjectId, project.hostedProjectId]) if (id) names.set(id, project.name);
    if (project.localProjectId) localIds.push(project.localProjectId);
  }
  if (space.kind === "personal") {
    names.set(WORKSPACE_ID, "Workspace");
    localIds.push(WORKSPACE_ID);
  }
  return { asks: { spaceId: space.id }, localIds: localIds.sort(), names };
}
