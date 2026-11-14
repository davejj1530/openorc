import type { Session } from "./session.js";
import { Refused } from "./session.js";
import { ROUTES } from "./wire.js";

interface Dependencies {
  session: Session;
  refresh(): Promise<void>;
}

/** Membership comes from the authenticated response, never from the invitation's cached display. */
export class ReceivedInvitations {
  constructor(private readonly deps: Dependencies) {}

  async accept(invitationId: string): Promise<{ spaceId: string }> {
    const generation = this.deps.session.generation;
    try {
      const result = await this.deps.session.request(ROUTES.acceptInvitation, { invitationId });
      this.#assert(generation);
      return { spaceId: result.member.organizationId };
    } finally {
      await this.#refresh(generation);
    }
  }

  async decline(invitationId: string): Promise<Record<string, never>> {
    const generation = this.deps.session.generation;
    try {
      await this.deps.session.request(ROUTES.declineInvitation, { invitationId });
      this.#assert(generation);
      return {};
    } finally {
      await this.#refresh(generation);
    }
  }

  async #refresh(generation: number): Promise<void> {
    this.#assert(generation);
    await this.deps.refresh();
    this.#assert(generation);
  }

  #assert(generation: number): void {
    if (!this.deps.session.state.signedIn || this.deps.session.generation !== generation) throw new Refused("Your OpenOrc session changed. Try again.");
  }
}
