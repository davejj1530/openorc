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
  /** The projects as Home groups them, in the space's order: each once, under one key. */
  groups: readonly { id: string; name: string; cloud?: true }[];
  /** The group key of every id a thread may carry for its project. */
  groupOf: ReadonlyMap<string, string>;
}

/** The Mac alone: Workspace and its projects, as Home lists a Mac with no account. */
export function macScope(choices: readonly ProjectChoice[]): ListScope {
  const localIds = choices.map((project) => project.id).sort();
  // The Workspace's threads belong to no project: their group comes last, as on the Mac's sidebar.
  const groups = [...choices.filter(({ id }) => id !== WORKSPACE_ID), ...choices.filter(({ id }) => id === WORKSPACE_ID)].map(({ id, name }) => ({ id, name }));
  return { asks: { projectIds: localIds }, localIds, names: new Map(choices.map(({ id, name }) => [id, name])), groups, groupOf: new Map(groups.map(({ id }) => [id, id])) };
}

/**
 * A space: its projects, whether they have a folder on this Mac, live on OpenOrc Cloud alone, or both, each named
 * under every id it has. Personal also holds the Mac's Workspace.
 */
export function spaceScope(space: Space, projects: readonly SpaceProject[] | undefined): ListScope {
  const names = new Map<string, string>();
  const groupOf = new Map<string, string>();
  const groups: { id: string; name: string; cloud?: true }[] = [];
  const localIds: string[] = [];
  for (const project of projects ?? []) {
    for (const id of [project.key, project.localProjectId, project.hostedProjectId])
      if (id) {
        names.set(id, project.name);
        groupOf.set(id, project.key);
      }
    groups.push({ id: project.key, name: project.name, ...(project.localProjectId ? {} : { cloud: true as const }) });
    if (project.localProjectId) localIds.push(project.localProjectId);
  }
  if (space.kind === "personal") {
    names.set(WORKSPACE_ID, "Workspace");
    groupOf.set(WORKSPACE_ID, WORKSPACE_ID);
    groups.push({ id: WORKSPACE_ID, name: "Workspace" });
    localIds.push(WORKSPACE_ID);
  }
  return { asks: { spaceId: space.id }, localIds: localIds.sort(), names, groups, groupOf };
}
