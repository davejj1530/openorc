/**
 * The stand-in's spaces and their projects, as the real server keeps them:
 *   every person has a personal space, `personal-<address>`, theirs alone, which their sessions are in by default
 *   a team has admins and members; project policy decides which members can use each project
 *   a request names its space in `x-openorc-space`; one naming a space its person is not in is refused in words
 *   GET /api/auth/organization/list lists a person's spaces, the personal one carrying `personalOf`, their user id
 */
import { randomUUID } from "node:crypto";

export interface StandInMember {
  id: string;
  email: string;
  role: "admin" | "member";
  createdAt: string;
}
export interface StandInTeam {
  name: string;
  logo: string | null;
  members: StandInMember[];
}

export interface StandInProject {
  id: string;
  name: string;
  fullName: string;
  repoId: number;
  defaultBranch: string;
  everyone: boolean;
  memberIds: string[];
}

type Reply = { status: number; body: unknown };

export const NOT_IN_SPACE: Reply = { status: 403, body: { message: "You're not in this organization.", statusCode: 403 } };

/** The id the stand-in's server knows a person by. */
export const userOf = (email: string): string => `user-${email}`;
const personal = (email: string): string => `personal-${email}`;

export class StandInSpaces {
  readonly teams = new Map<string, StandInTeam>();
  readonly #projects = new Map<string, StandInProject[]>();
  #repoIds = 0;

  /** Every space the person is in, as the real server's organization list answers them. */
  spacesOf(who: string): { id: string; name: string; slug: string; personalOf: string | null }[] {
    const teams = [...this.teams].filter(([, team]) => team.members.some((member) => member.email === who)).map(([id, team]) => ({ id, name: team.name, slug: id, personalOf: null }));
    return [{ id: personal(who), name: "Personal", slug: personal(who), personalOf: userOf(who) }, ...teams];
  }

  /** The space a request is in: the one it names, which its person must be in, else their personal space. */
  resolve(who: string, named: string | null): string | Reply {
    if (!named) return personal(who);
    return this.spacesOf(who).some((space) => space.id === named) ? named : NOT_IN_SPACE;
  }

  /** The people who read a space's threads: its person alone for a personal space, every member for a team. */
  readers(space: string): string[] {
    return this.teams.get(space)?.members.map((member) => member.email) ?? (space.startsWith("personal-") ? [space.slice("personal-".length)] : []);
  }

  addTeam(name: string, members: string[]): string {
    const id = `team-${randomUUID()}`;
    this.teams.set(id, { name, logo: null, members: members.map((email, i) => ({ id: randomUUID(), email, role: i === 0 ? "admin" : "member", createdAt: new Date().toISOString() })) });
    return id;
  }

  /** A project in the person's personal space, or in a space named. Answers its id. */
  addProject(email: string, project: { name: string; fullName: string; repoId?: number; defaultBranch?: string }, space = personal(email)): string {
    const id = randomUUID();
    const kept: StandInProject = {
      id,
      name: project.name,
      fullName: project.fullName,
      repoId: project.repoId ?? ++this.#repoIds + 1000,
      defaultBranch: project.defaultBranch ?? "main",
      everyone: true,
      memberIds: [],
    };
    this.#projects.set(space, [...(this.#projects.get(space) ?? []), kept]);
    return id;
  }

  /** Takes a project out of a space, as DELETE /projects/:id does. Answers whether it was there. */
  removeProject(space: string, id: string): boolean {
    const before = this.projectsIn(space);
    this.#projects.set(
      space,
      before.filter((project) => project.id !== id),
    );
    return before.some((project) => project.id === id);
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
  listed(space: string, who?: string) {
    return this.projectsIn(space)
      .filter((project) => !who || this.canRead(space, project.id, who))
      .map(({ everyone: _everyone, memberIds: _memberIds, ...project }) => ({ ...project, connected: true }));
  }

  canRead(space: string, projectId: string, who: string): boolean {
    if (space === personal(who)) return true;
    const member = this.member(space, who);
    const project = this.project(space, projectId);
    return Boolean(member && project && (member.role === "admin" || project.everyone || project.memberIds.includes(member.id)));
  }

  member(space: string, who: string): StandInMember | undefined {
    return this.teams.get(space)?.members.find((member) => member.email === who);
  }

  removeMember(space: string, who: string): void {
    const id = this.member(space, who)?.id;
    const team = this.teams.get(space);
    if (team) team.members = team.members.filter((member) => member.email !== who);
    for (const project of this.projectsIn(space)) project.memberIds = project.memberIds.filter((memberId) => memberId !== id);
  }

  deleteOrganization(space: string): void {
    this.teams.delete(space);
    this.#projects.delete(space);
  }
}
