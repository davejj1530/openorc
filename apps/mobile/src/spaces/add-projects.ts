import type { OrganizationProjectAdded, OrganizationRepositories, SpaceProject } from "@openorc/protocol";
import { useOwnCloud } from "../cloud/use-own-cloud";
import { closedToPerson, useSpaces, type PhoneSpaces } from "./use-spaces";

export type Repository = OrganizationRepositories["repositories"][number];

export const repositoryKey = (repository: Pick<Repository, "installationId" | "repoId">): string => `${repository.installationId}:${repository.repoId}`;

/**
 * The space this phone may add projects to now, or null: its own session of OpenOrc Cloud does the adding, so it needs
 * one; a person adds to their own space, and an organization's admin to it, as the Mac's sidebar offers Add project.
 */
export function projectAdding(own: boolean, account: PhoneSpaces, now: number): string | null {
  if (!own || account.state !== "ready") return null;
  const space = account.current;
  if (closedToPerson(space, account.access, now)) return null;
  return space.kind === "personal" || space.role === "admin" ? space.id : null;
}

export function useProjectAdding(): string | null {
  return projectAdding(useOwnCloud(), useSpaces(), Date.now());
}

/** A repository as the sheet lists it: already a project, ticked to become one, or neither; and why the last try at it was refused. */
export interface RepositoryRow {
  key: string;
  /** The repository's own name, without its owner. */
  name: string;
  repository: Repository;
  state: "added" | "chosen" | "open";
  error: string | null;
}

/** The space's repositories whose name holds `query`, in the server's order, each with where it stands. */
export function repositoryRows(repositories: readonly Repository[], query: string, chosen: readonly string[], outcomes: readonly OrganizationProjectAdded[]): RepositoryRow[] {
  const search = query.trim().toLocaleLowerCase();
  return repositories
    .filter((repository) => repository.fullName.toLocaleLowerCase().includes(search))
    .map((repository) => {
      const key = repositoryKey(repository);
      const outcome = outcomes.find((each) => repositoryKey(each) === key);
      const state = (): RepositoryRow["state"] => {
        if (repository.projectId !== null || outcome?.state === "added") return "added";
        return chosen.includes(key) ? "chosen" : "open";
      };
      return { key, name: repository.fullName.split("/").at(-1) ?? repository.fullName, repository, state: state(), error: outcome?.state === "refused" ? outcome.error : null };
    });
}

export const addLabel = (count: number): string => (count > 1 ? `Add ${count} projects` : "Add project");

/**
 * The first project just added, by the id New thread chooses it with: the Mac's folder for it where the Mac has one,
 * else the cloud project's own key. Null until the space lists it.
 */
export function addedChoice(projects: readonly SpaceProject[] | undefined, added: readonly OrganizationProjectAdded[]): string | null {
  const first = added.find((each) => each.state === "added");
  const project = first?.state === "added" ? projects?.find((each) => each.hostedProjectId === first.projectId) : undefined;
  return project ? (project.localProjectId ?? project.key) : null;
}
