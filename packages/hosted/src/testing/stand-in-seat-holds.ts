import { randomUUID } from "node:crypto";
import type { WireOrganizationBilling } from "../organization-billing-wire.js";

type Reply = { status: number; body: unknown };
type Seat = WireOrganizationBilling["seats"][number];
type Held = { id: string; email: string; expiresAt: number };
const refuse = (status: number, message: string): Reply => ({ status, body: { message } });
const NOT_HERE = "That seat isn't in this organization.";
const UNPAID = "The payment for these seats didn't go through. Update the payment method in billing and try again.";
const NONE = "There are no available seats. Buy another seat or take one back first.";
const TAKEN = "That seat was just taken. Send the invitation again.";

interface Deps {
  records: Map<string, WireOrganizationBilling>;
  now(): number;
  changed(spaceId: string): void;
}

/**
 * The seat an invitation holds, as the seats contract's unit 5 words it. A hold counts against the free seats until
 * the invitation is accepted, revoked, declined or expired; an expired invitation remembers its seat for a resend.
 */
export class StandInSeatHolds {
  /** Each invitation's seat, live or lapsed with its invitation. */
  readonly #seats = new Map<string, { spaceId: string; seatId: string }>();
  constructor(private readonly deps: Deps) {}

  /**
   * A refusal, which leaves nothing behind, or the step that holds the seat once the invitation is written. With no
   * seat named, a resend keeps a live hold and takes an expired invitation's own seat again.
   */
  reserve(input: { spaceId: string; seatId: string | undefined; invitationId: string | null }): Reply | ((invitation: Held) => void) {
    this.sweep();
    const kept = input.invitationId ? this.#seats.get(input.invitationId) : undefined;
    const seatId = input.seatId ?? kept?.seatId;
    if (seatId === undefined) return () => {};
    const billing = this.deps.records.get(input.spaceId);
    const seat = billing?.seats.find((each) => each.id === seatId);
    if (!billing || !seat) return refuse(404, NOT_HERE);
    if (billing.subscription?.standing !== "live" && billing.subscription?.standing !== "ending") return refuse(402, UNPAID);
    const own = seat.assignment.kind === "invitation" && seat.assignment.invitationId === input.invitationId;
    if (!own && !free(seat)) return refuse(409, billing.seats.some(free) ? TAKEN : NONE);
    return (invitation) => {
      if (input.invitationId) this.release(input.invitationId);
      seat.assignment = { kind: "invitation", invitationId: invitation.id, email: invitation.email, expiresAt: new Date(invitation.expiresAt).toISOString() };
      this.#seats.set(invitation.id, { spaceId: input.spaceId, seatId });
      this.#changed(input.spaceId);
    };
  }

  /** True only while the open invitation holds a seat whose subscription is paid. */
  includes(invitationId: string): boolean {
    this.sweep();
    const seat = this.#held(invitationId);
    const standing = seat && this.deps.records.get(this.#seats.get(invitationId)!.spaceId)?.subscription?.standing;
    return standing === "live" || standing === "ending";
  }

  /** Revoked or declined: the seat is free again and the invitation remembers none. */
  release(invitationId: string): void {
    const seat = this.#held(invitationId);
    const kept = this.#seats.get(invitationId);
    this.#seats.delete(invitationId);
    if (!seat || !kept) return;
    seat.assignment = { kind: "available" };
    this.#changed(kept.spaceId);
  }

  /** Joining takes the seat with the membership while the seats are paid; after a lapse the person joins without it. */
  accept(invitationId: string, member: { memberId: string; person: { id: string; name: string; email: string; image: string | null }; paysForPro: boolean }): void {
    const paid = this.includes(invitationId);
    const seat = this.#held(invitationId);
    const kept = this.#seats.get(invitationId);
    if (!paid || !seat || !kept) return this.release(invitationId);
    this.#seats.delete(invitationId);
    seat.assignment = { kind: "member", ...member };
    this.#changed(kept.spaceId);
  }

  /** A hold stops counting at its invitation's expiry, with no event: every read frees what has lapsed. */
  sweep(): void {
    const now = this.deps.now();
    for (const [spaceId, billing] of this.deps.records) {
      const lapsed = billing.seats.filter((seat) => seat.assignment.kind === "invitation" && Date.parse(seat.assignment.expiresAt) <= now);
      for (const seat of lapsed) seat.assignment = { kind: "available" };
      if (lapsed.length) this.#changed(spaceId, false);
    }
  }

  #held(invitationId: string): Seat | undefined {
    const kept = this.#seats.get(invitationId);
    return this.deps.records.get(kept?.spaceId ?? "")?.seats.find((seat) => seat.id === kept?.seatId && seat.assignment.kind === "invitation" && seat.assignment.invitationId === invitationId);
  }

  #changed(spaceId: string, tell = true): void {
    const billing = this.deps.records.get(spaceId);
    if (!billing) return;
    billing.revision = randomUUID();
    billing.available = billing.seats.filter(free).length;
    if (tell) this.deps.changed(spaceId);
  }
}

const free = (seat: Seat): boolean => seat.assignment.kind === "available" && seat.retiresAt === null;
