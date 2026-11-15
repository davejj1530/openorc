import type { RpcParams, RpcResults } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { Refused, type Session } from "./session.js";
import { ROUTES, type Route } from "./wire.js";
import { DeletionConflict } from "./wire-spaces.js";

interface Dependencies extends Pick<HostedDeps, "push"> {
  session: Session;
  refresh(): Promise<void>;
  /** Whether the space is an organization this person belongs to, as last read. */
  organization(spaceId: string): boolean;
}

/** Membership writes use explicit targets and reconcile authority before returning success. */
export class OrganizationMembers {
  constructor(private readonly deps: Dependencies) {}

  async setRole({ spaceId, memberId, role }: RpcParams<"organization.member.setRole">): Promise<RpcResults["organization.member.setRole"]> {
    const member = await this.#change(spaceId, ROUTES.setMemberRole(memberId), { role });
    return { memberId: member.id, spaceId: member.organizationId, userId: member.userId, role: member.role, joinedAt: Date.parse(member.createdAt) };
  }

  async remove({ spaceId, memberId }: RpcParams<"organization.member.remove">): Promise<RpcResults["organization.member.remove"]> {
    await this.#change(spaceId, ROUTES.removeMember(memberId));
    return {};
  }

  async leave({ spaceId }: RpcParams<"organization.leave">): Promise<RpcResults["organization.leave"]> {
    await this.#change(spaceId, ROUTES.leaveOrganization);
    return {};
  }

  /**
   * The one conflict an organization's deletion meets is its billing: seats still paid, ending, or being settled. That
   * is an answer the window acts on, not a failure, so it is returned with its date as a value.
   */
  async delete({ spaceId, name }: RpcParams<"organization.delete">): Promise<RpcResults["organization.delete"]> {
    const organization = this.deps.organization(spaceId);
    try {
      await this.#change(spaceId, ROUTES.deleteOrganization, { name });
      return {};
    } catch (error) {
      if (!(error instanceof DeletionConflict)) throw error;
      if (!organization) throw new Refused(error.message, 409);
      return { refusal: { message: error.message, endsAt: error.endsAt } };
    }
  }

  async #change<T>(spaceId: string, route: Route<T>, body?: unknown): Promise<T> {
    const generation = this.deps.session.generation;
    try {
      const reply = await this.deps.session.in(spaceId).request(route, body);
      this.#assert(generation);
      return reply;
    } finally {
      if (generation === this.deps.session.generation) {
        await this.deps.refresh();
        this.#assert(generation);
        this.deps.push({ type: "invalidate", keys: ["spaces", "projects", `people:${spaceId}`, `invitations:${spaceId}`] });
      }
    }
  }

  #assert(generation: number): void {
    if (!this.deps.session.state.signedIn || this.deps.session.generation !== generation) throw new Refused("Your OpenOrc session changed. Try again.");
  }
}
