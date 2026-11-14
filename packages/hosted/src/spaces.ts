import type { OrganizationPeople, ReceivedInvitation, SpaceProject, SpacesStatus } from "@openorc/protocol";
import { z } from "zod";
import type { HostedDeps, HostedSpaces } from "./index.js";
import { Refused, type Session, type SessionChange } from "./session.js";
import { scopedProject, spaceProjects, type ScopedProject } from "./space-projects.js";
import { ROUTES, SOCKET, wireTopics } from "./wire.js";
import { OrganizationSetup } from "./organization-setup.js";
import { OrganizationMembers } from "./organization-members.js";
import { OrganizationAccess } from "./organization-access.js";
import { wireSpaces } from "./wire-spaces.js";

const snapshot = z.object({ apiOrigin: z.string(), email: z.string(), index: wireSpaces, projects: z.array(scopedProject), heardAt: z.number() });
type Snapshot = z.infer<typeof snapshot>;
export interface SpaceCatalog {
  me: string | null;
  personal: string | null;
  ids: string[];
  projects: ScopedProject[];
}
type SpacesDeps = { session: Session } & Pick<HostedDeps, "browser" | "server" | "kept" | "projects" | "push" | "now">;

/** The account's membership and project authority, independent of any window's selected space. */
export class Spaces implements HostedSpaces {
  readonly setup: OrganizationSetup;
  readonly membership: OrganizationMembers;
  readonly access: OrganizationAccess;
  #snapshot: Snapshot | null = null;
  #legacy: SpaceCatalog | null = null;
  #invitations: ReceivedInvitation[] = [];
  #error: string | null = null;
  #announced = "";
  #generation = -1;
  #reading: Promise<void> | null = null;
  #again: Promise<void> | null = null;
  #closed = false;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  readonly #origin: string;

  constructor(private readonly deps: SpacesDeps) {
    this.setup = new OrganizationSetup({ ...deps, refresh: () => this.refresh(), status: () => this.status() });
    this.membership = new OrganizationMembers({ ...deps, refresh: () => this.refresh() });
    this.access = new OrganizationAccess({ ...deps, refresh: () => this.refresh() });
    this.#origin = new URL(deps.server).origin;
    deps.session.onChange((change) => this.#changed(change));
    deps.session.onSocket(SOCKET.changed, (body) => {
      const event = wireTopics.safeParse(body);
      if (!event.success) return;
      const { organizationId, topics } = event.data;
      const keys = topics.flatMap((topic) => {
        if (topic === "members" && organizationId) return [`people:${organizationId}`];
        if (topic === "invitations" && organizationId) return [`invitations:${organizationId}`];
        return [];
      });
      if (keys.length) deps.push({ type: "invalidate", keys });
      if (topics.some((topic) => ["spaces", "projects", "members", "invitations"].includes(topic))) void this.refresh();
    });
  }

  status(): SpacesStatus {
    const state = this.deps.session.state;
    if (!state.signedIn) return { state: "signed-out" };
    const heard = this.#snapshot;
    if (!heard) return { state: "loading", error: this.#error };
    return {
      state: "ready",
      ...heard.index,
      apiOrigin: this.#origin,
      invitations: this.#invitations.filter((invitation) => invitation.expiresAt > this.deps.now()),
      reach: state.reach,
      heardAt: heard.heardAt,
      error: this.#error,
    };
  }

  async projects(spaceId: string): Promise<SpaceProject[]> {
    await (this.#reading ?? (this.#snapshot ? undefined : this.refresh()));
    const heard = this.#require(spaceId);
    return spaceProjects(spaceId, heard.index.personalSpaceId, heard.projects, this.deps.projects());
  }

  async people(spaceId: string, offset = 0, limit = 100): Promise<OrganizationPeople> {
    const generation = this.deps.session.generation;
    const read = await this.deps.session.in(spaceId).request(ROUTES.people(offset, limit));
    this.#assertCurrent(generation);
    return { ...read, members: read.members.map((member) => ({ ...member, joinedAt: Date.parse(member.joinedAt) })) };
  }

  /** Threads consume this same catalog, including a legacy server's read-only list during rollout. */
  async catalog(): Promise<SpaceCatalog> {
    await (this.#reading ?? (this.#snapshot || this.#legacy ? undefined : this.refresh()));
    const heard = this.#snapshot;
    if (heard) return { me: heard.index.userId, personal: heard.index.personalSpaceId, ids: heard.index.spaces.map((space) => space.id), projects: heard.projects };
    if (this.#legacy) return this.#legacy;
    throw new Error(this.#error ?? "OpenOrc Cloud can't be reached.");
  }

  refresh(): Promise<void> {
    if (!this.#reading) {
      const reading = this.#read().finally(() => {
        if (this.#reading === reading) this.#reading = null;
      });
      this.#reading = reading;
      return reading;
    }
    this.#again ??= this.#reading.then(() => {
      this.#again = null;
      return this.refresh();
    });
    return this.#again;
  }

  async #read(): Promise<void> {
    const state = this.deps.session.state;
    if (!state.signedIn || this.#closed) return;
    const generation = this.deps.session.generation;
    try {
      const index = await this.deps.session.request(ROUTES.spaceIndex);
      const [projects, inbox] = await Promise.all([
        this.#readProjects(index.spaces.map((space) => space.id)),
        this.deps.session.request(ROUTES.receivedInvitations).then(
          (read) => ({ read, error: null }),
          (error: unknown) => ({ read: null, error: words(error) }),
        ),
      ]);
      if (!this.#current(generation)) return;
      this.#snapshot = { apiOrigin: this.#origin, email: state.email, index, projects: projects.rows, heardAt: this.deps.now() };
      this.#error = projects.error ?? inbox.error;
      if (inbox.read) this.#invitations = inbox.read.invitations.map((invitation) => ({ ...invitation, expiresAt: Date.parse(invitation.expiresAt) }));
      this.#save();
      this.#setExpiry();
    } catch (error) {
      if (!this.#current(generation)) return;
      this.#error = words(error);
      // Older servers still serve the existing mixed thread list. New organization screens retain a readable error.
      if (error instanceof Refused && error.status === 404 && !this.#snapshot) await this.#readLegacy(generation);
    }
    if (this.#current(generation)) this.#tell();
  }

  async #readProjects(ids: string[]): Promise<{ rows: ScopedProject[]; error: string | null }> {
    const answers = await Promise.allSettled(ids.map(async (space) => (await this.deps.session.in(space).request(ROUTES.projects)).map((project) => ({ ...project, space }))));
    let error: string | null = null;
    const rows = answers.flatMap((answer, i) => {
      if (answer.status === "fulfilled") return answer.value;
      if (answer.reason instanceof Refused && [403, 404].includes(answer.reason.status ?? 0)) return [];
      error = words(answer.reason);
      return this.#snapshot?.projects.filter((project) => project.space === ids[i]) ?? [];
    });
    return { rows, error };
  }

  async #readLegacy(generation: number): Promise<void> {
    try {
      const spaces = await this.deps.session.request(ROUTES.spaces);
      const projects = await this.#readProjects(spaces.map((space) => space.id));
      const personal = spaces.find((space) => space.personalOf);
      if (this.#current(generation)) this.#legacy = { me: personal?.personalOf ?? null, personal: personal?.id ?? null, ids: spaces.map((space) => space.id), projects: projects.rows };
    } catch {
      /* Keep the existing read error while the server is unavailable. */
    }
  }

  #require(spaceId: string): Snapshot {
    const heard = this.#snapshot;
    if (!heard?.index.spaces.some((space) => space.id === spaceId)) throw new Refused("You're not in this organization.");
    return heard;
  }

  #changed(change: SessionChange): void {
    const { session } = this.deps;
    const state = session.state;
    if (this.#generation !== session.generation) {
      if (!state.signedIn) this.#forget();
      this.#generation = session.generation;
      this.#reading = null;
      this.#again = null;
      this.#snapshot = state.signedIn ? (this.#saved().find((row) => row.apiOrigin === this.#origin && row.email === state.email) ?? null) : null;
      this.#legacy = null;
      this.#invitations = [];
      this.#error = null;
      this.#setExpiry();
    }
    this.#tell();
    if (change === "connected") void this.refresh();
  }

  #saved(): Snapshot[] {
    try {
      return z.array(snapshot).parse(JSON.parse(this.deps.kept.load("spaces") ?? "[]"));
    } catch {
      return [];
    }
  }

  #save(): void {
    const heard = this.#snapshot;
    if (!heard) return;
    const others = this.#saved().filter((row) => row.apiOrigin !== this.#origin || row.index.userId !== heard.index.userId);
    this.deps.kept.save("spaces", JSON.stringify([...others, heard]));
  }

  #forget(): void {
    const heard = this.#snapshot;
    if (!heard) return;
    const others = this.#saved().filter((row) => row.apiOrigin !== this.#origin || row.index.userId !== heard.index.userId);
    this.deps.kept.save("spaces", others.length ? JSON.stringify(others) : null);
  }

  #setExpiry(): void {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    const future = this.#invitations.map((invite) => invite.expiresAt - this.deps.now()).filter((left) => left > 0);
    if (future.length)
      this.#expiry = setTimeout(
        () => {
          this.#tell();
          this.#setExpiry();
        },
        Math.min(...future, 2_147_483_647) + 1,
      );
  }

  #current(generation: number): boolean {
    return !this.#closed && this.deps.session.state.signedIn && this.deps.session.generation === generation;
  }
  #assertCurrent(generation: number): void {
    if (!this.#current(generation)) throw new Refused("Your OpenOrc session changed. Try again.");
  }
  #tell(): void {
    const status = this.status();
    const facts = status.state === "ready" ? { ...status, heardAt: 0 } : status;
    const next = JSON.stringify([facts, this.#snapshot?.projects]);
    if (next === this.#announced) return;
    this.#announced = next;
    this.deps.push({ type: "invalidate", keys: ["spaces", "projects"] });
  }
  close(): void {
    this.#closed = true;
    this.setup.close();
    if (this.#expiry) clearTimeout(this.#expiry);
  }
}

const words = (error: unknown): string => (error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
