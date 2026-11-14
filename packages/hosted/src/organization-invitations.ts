import { InvitationEmail, type OrganizationInvitation, type OrganizationInviteResult, type RpcParams } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { Refused, type Session } from "./session.js";
import { ROUTES } from "./wire.js";

interface Dependencies extends Pick<HostedDeps, "push" | "now"> {
  session: Session;
  refresh(): Promise<void>;
}

/** Each invitation belongs to its captured organization, including retries and delivery reads. */
export class OrganizationInvitations {
  constructor(private readonly deps: Dependencies) {}

  async list(spaceId: string): Promise<OrganizationInvitation[]> {
    const generation = this.deps.session.generation;
    const read = await this.deps.session.in(spaceId).request(ROUTES.sentInvitations);
    this.#assert(generation);
    const now = this.deps.now();
    return read.invitations.map((invite) => ({
      ...invite,
      expiresAt: Date.parse(invite.expiresAt),
      delivery: invite.delivery ? { ...invite.delivery, at: Date.parse(invite.delivery.at) } : null,
      resendAt: now + invite.resendAfterMs,
    }));
  }

  async send({ spaceId, emails, role }: RpcParams<"organization.invite">): Promise<OrganizationInviteResult[]> {
    const generation = this.deps.session.generation;
    const results: OrganizationInviteResult[] = [];
    for (const email of new Set(emails.map((email) => email.trim().toLowerCase()))) {
      this.#assert(generation);
      results.push(await this.#send(spaceId, email, role, generation));
    }
    await this.#changed(spaceId, generation);
    return results;
  }

  async #send(spaceId: string, email: string, role: "admin" | "member", generation: number): Promise<OrganizationInviteResult> {
    if (!InvitationEmail.safeParse(email).success) return { email, state: "refused", error: "Enter a full email address." };
    try {
      const record = await this.deps.session.in(spaceId).request(ROUTES.invite, { organizationId: spaceId, email, role });
      this.#assert(generation);
      let invitation: OrganizationInvitation | null = null;
      let error: string | null = null;
      try {
        invitation = (await this.list(spaceId)).find((invite) => invite.id === record.id) ?? null;
      } catch (failure) {
        this.#assert(generation);
        error = words(failure);
      }
      return { email, state: "sent", invitationId: record.id, invitation, error };
    } catch (error) {
      this.#assert(generation);
      const state = error instanceof Refused ? already(error.code) : "refused";
      return { email, state, error: words(error) };
    }
  }

  async resend({ spaceId, invitationId }: RpcParams<"organization.invitation.resend">): Promise<OrganizationInvitation> {
    const generation = this.deps.session.generation;
    try {
      const invitation = await this.#find(spaceId, invitationId);
      const sent = await this.deps.session.in(spaceId).request(ROUTES.invite, { organizationId: spaceId, email: invitation.email, role: invitation.role, resend: true });
      this.#assert(generation);
      return await this.#find(spaceId, sent.id);
    } finally {
      await this.#changed(spaceId, generation);
    }
  }

  async revoke({ spaceId, invitationId }: RpcParams<"organization.invitation.revoke">): Promise<Record<string, never>> {
    const generation = this.deps.session.generation;
    try {
      await this.#find(spaceId, invitationId);
      await this.deps.session.in(spaceId).request(ROUTES.revokeInvitation, { invitationId });
      this.#assert(generation);
      return {};
    } finally {
      await this.#changed(spaceId, generation);
    }
  }

  async #find(spaceId: string, id: string): Promise<OrganizationInvitation> {
    const found = (await this.list(spaceId)).find((invite) => invite.id === id);
    if (!found) throw new Refused("This invitation is no longer available.");
    return found;
  }

  async #changed(spaceId: string, generation: number): Promise<void> {
    this.#assert(generation);
    await this.deps.refresh();
    this.#assert(generation);
    this.deps.push({ type: "invalidate", keys: [`invitations:${spaceId}`, `people:${spaceId}`, "spaces"] });
  }

  #assert(generation: number): void {
    if (!this.deps.session.state.signedIn || generation !== this.deps.session.generation) throw new Refused("Your OpenOrc session changed. Try again.");
  }
}

function already(code: string | undefined): "already-member" | "already-invited" | "refused" {
  if (code === "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION") return "already-member";
  if (code === "USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION") return "already-invited";
  return "refused";
}
const words = (error: unknown) => (error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
