import type { OrganizationProjectAdded, OrganizationRepositories, RpcParams, RpcResults, SpacesStatus } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { GithubConnect } from "./github.js";
import { Refused, type Session } from "./session.js";
import { ROUTES } from "./wire.js";

interface Dependencies extends Pick<HostedDeps, "browser" | "push"> {
  session: Session;
  refresh(): Promise<void>;
  status(): SpacesStatus;
}
const words = (error: unknown) => (error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");

/** Identity and setup writes capture their account and target before the first asynchronous step. */
export class OrganizationSetup {
  readonly #connections = new Map<string, GithubConnect>();
  #creating: Promise<RpcResults["spaces.create"]> | null = null;
  #uncertain: { name: string; before: Set<string> } | null = null;
  #generation: number;

  constructor(private readonly deps: Dependencies) {
    this.#generation = deps.session.generation;
    deps.session.onChange(() => {
      if (this.#generation === deps.session.generation) return;
      this.#generation = deps.session.generation;
      this.close();
      this.#creating = null;
      this.#uncertain = null;
    });
  }

  create(input: RpcParams<"spaces.create">): Promise<RpcResults["spaces.create"]> {
    if (this.#creating) return this.#creating;
    const pending = this.#create(input).finally(() => {
      if (this.#creating === pending) this.#creating = null;
    });
    this.#creating = pending;
    return pending;
  }

  async #create(input: RpcParams<"spaces.create">): Promise<RpcResults["spaces.create"]> {
    const generation = this.deps.session.generation;
    await this.deps.refresh();
    this.#assert(generation);
    const status = this.deps.status();
    if (status.state !== "ready" || status.reach !== "live") throw new Refused("OpenOrc Cloud can't be reached.");
    const name = input.name.normalize("NFKC").trim().replace(/\s+/g, " ");
    const prior = this.#uncertain;
    const recovered = prior?.name === name ? status.spaces.find((space) => space.kind === "organization" && space.name === name && !prior.before.has(space.id)) : undefined;
    let spaceId = recovered?.id;
    if (!spaceId) {
      if (!status.create.allowed) throw new Refused(status.create.reason ?? "Creating organizations isn't available on this server.");
      this.#uncertain = { name, before: new Set(status.spaces.map((space) => space.id)) };
      try {
        spaceId = (await this.deps.session.request(ROUTES.createOrganization, { name: input.name, keepCurrentActiveOrganization: true })).id;
      } catch (error) {
        if (error instanceof Refused) this.#uncertain = null;
        await this.deps.refresh();
        this.#assert(generation);
        throw error;
      }
    }
    this.#assert(generation);
    this.#uncertain = null;
    let logoError: string | null = null;
    if (input.logo) {
      try {
        await this.update({ spaceId, logo: input.logo });
      } catch (error) {
        this.#assert(generation);
        logoError = words(error);
      }
    }
    await this.deps.refresh();
    this.#assert(generation);
    return { spaceId, logoError };
  }

  async update({ spaceId, ...input }: RpcParams<"organization.update">): Promise<RpcResults["organization.update"]> {
    const generation = this.deps.session.generation;
    const identity = await this.deps.session.in(spaceId).request(ROUTES.updateOrganization, input);
    this.#assert(generation);
    await this.deps.refresh();
    this.#assert(generation);
    this.deps.push({ type: "invalidate", keys: ["spaces", `people:${spaceId}`] });
    return { id: spaceId, name: identity.name, logo: identity.logo };
  }

  async repositories(spaceId: string): Promise<OrganizationRepositories> {
    const generation = this.deps.session.generation;
    const requests = this.deps.session.in(spaceId);
    const [github, repositories, projects] = await Promise.all([requests.request(ROUTES.organizationGithub), requests.request(ROUTES.organizationRepositories), requests.request(ROUTES.projects)]);
    this.#assert(generation);
    return {
      ...github,
      repositories: repositories.map((repo) => ({ ...repo, projectId: projects.find((project) => project.fullName.toLowerCase() === repo.fullName.toLowerCase())?.id ?? null })),
      connecting: this.#connections.get(spaceId)?.work ?? null,
    };
  }

  async connect(spaceId: string, choice: Omit<RpcParams<"organization.github.connect">, "spaceId"> = {}): Promise<OrganizationRepositories> {
    const generation = this.deps.session.generation;
    let connection = this.#connections.get(spaceId);
    if (!connection) {
      connection = new GithubConnect({
        session: this.deps.session,
        requests: this.deps.session.in(spaceId),
        browser: this.deps.browser,
        changed: () => this.deps.push({ type: "invalidate", keys: [`repositories:${spaceId}`] }),
        landed: async () => {
          await this.deps.refresh();
          this.deps.push({ type: "invalidate", keys: [`repositories:${spaceId}`] });
        },
      });
      this.#connections.set(spaceId, connection);
    }
    if (connection.work?.state !== "waiting") await connection.connect(choice);
    this.#assert(generation);
    return this.repositories(spaceId);
  }

  /** Takes one project out of the space's cloud; the server deletes its cloud threads with it. */
  async removeProject({ spaceId, projectId }: RpcParams<"organization.projects.remove">): Promise<Record<string, never>> {
    const generation = this.deps.session.generation;
    await this.deps.session.in(spaceId).request(ROUTES.removeProject(projectId));
    await this.deps.refresh();
    this.#assert(generation);
    this.deps.push({ type: "invalidate", keys: ["projects", "spaces", `repositories:${spaceId}`] });
    return {};
  }

  async addProjects({ spaceId, repositories }: RpcParams<"organization.projects.add">): Promise<OrganizationProjectAdded[]> {
    const generation = this.deps.session.generation;
    const results: OrganizationProjectAdded[] = [];
    for (const repository of repositories) {
      this.#assert(generation);
      try {
        const [project] = await this.deps.session.in(spaceId).request(ROUTES.addProjects, { repositories: [repository] });
        if (!project) throw new Error("OpenOrc Cloud didn't return the added project.");
        results.push({ ...repository, state: "added", projectId: project.id });
      } catch (error) {
        this.#assert(generation);
        results.push({ ...repository, state: "refused", error: words(error) });
      }
    }
    await this.deps.refresh();
    this.#assert(generation);
    this.deps.push({ type: "invalidate", keys: ["projects", "spaces", `repositories:${spaceId}`] });
    return results;
  }

  #assert(generation: number): void {
    if (!this.deps.session.state.signedIn || this.deps.session.generation !== generation) throw new Refused("Your OpenOrc session changed. Try again.");
  }
  close(): void {
    for (const connection of this.#connections.values()) connection.forget();
    this.#connections.clear();
  }
}
