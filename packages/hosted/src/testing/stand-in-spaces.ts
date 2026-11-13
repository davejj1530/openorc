/**
 * The stand-in's spaces and their projects, as the real server keeps them:
 *   every person has a personal space, `personal-<address>`, theirs alone, which their sessions are in by default
 *   a team is a space of several people; each sees its projects (the real server lets a member use only the projects
 *   an admin granted them, and an admin every one: here every member uses every project of their team)
 *   a request names its space in `x-openorc-space`; one naming a space its person is not in is refused in words
 *   GET /api/auth/organization/list lists a person's spaces, the personal one carrying `personalOf`, their user id
 */
import { randomUUID } from "node:crypto";

export interface StandInProject {
  id: string;
  name: string;
  fullName: string;
  repoId: number;
  defaultBranch: string;
}

type Reply = { status: number; body: unknown };

export const NOT_IN_SPACE: Reply = { status: 403, body: { message: "You're not in this organization.", statusCode: 403 } };

/** The id the stand-in's server knows a person by. */
export const userOf = (email: string): string => `user-${email}`;
const personal = (email: string): string => `personal-${email}`;

export class StandInSpaces {
  readonly #teams = new Map<string, { name: string; members: string[] }>();
  readonly #projects = new Map<string, StandInProject[]>();
  #repoIds = 0;

  /** Every space the person is in, as the real server's organization list answers them. */
  spacesOf(who: string): { id: string; name: string; slug: string; personalOf: string | null }[] {
    const teams = [...this.#teams].filter(([, team]) => team.members.includes(who)).map(([id, team]) => ({ id, name: team.name, slug: id, personalOf: null }));
    return [{ id: personal(who), name: "Personal", slug: personal(who), personalOf: userOf(who) }, ...teams];
  }

  /** The space a request is in: the one it names, which its person must be in, else their personal space. */
  resolve(who: string, named: string | null): string | Reply {
    if (!named) return personal(who);
    return this.spacesOf(who).some((space) => space.id === named) ? named : NOT_IN_SPACE;
  }

  /** The people who read a space's threads: its person alone for a personal space, every member for a team. */
  readers(space: string): string[] {
    return this.#teams.get(space)?.members ?? (space.startsWith("personal-") ? [space.slice("personal-".length)] : []);
  }

  addTeam(name: string, members: string[]): string {
    const id = `team-${randomUUID()}`;
    this.#teams.set(id, { name, members });
    return id;
  }

  /** A project in the person's personal space, or in a space named. Answers its id. */
  addProject(email: string, project: { name: string; fullName: string; repoId?: number; defaultBranch?: string }, space = personal(email)): string {
    const id = randomUUID();
    const kept: StandInProject = { id, name: project.name, fullName: project.fullName, repoId: project.repoId ?? ++this.#repoIds + 1000, defaultBranch: project.defaultBranch ?? "main" };
    this.#projects.set(space, [...(this.#projects.get(space) ?? []), kept]);
    return id;
  }

  /** A repository made a project of a space, or the project it already is, as POST /projects answers. */
  ensureProject(space: string, repository: { fullName: string; repoId: number; defaultBranch: string }): StandInProject {
    const known = this.projectsIn(space).find((project) => project.repoId === repository.repoId);
    if (known) return known;
    const id = this.addProject("", { name: repository.fullName.split("/")[1]!, ...repository }, space);
    return this.project(space, id)!;
  }

  projectsIn(space: string): StandInProject[] {
    return this.#projects.get(space) ?? [];
  }

  project(space: string, id: string | null): StandInProject | null {
    return this.projectsIn(space).find((project) => project.id === id) ?? null;
  }

  /** The space a project is in; a thread on no project is in its starter's personal space. */
  spaceOfProject(id: string | null, starter: string): string {
    for (const [space, projects] of this.#projects) if (projects.some((project) => project.id === id)) return space;
    return personal(starter);
  }

  /** GET /projects as the real server answers it. */
  listed(space: string) {
    return this.projectsIn(space).map((project) => ({ ...project, connected: true }));
  }
}
