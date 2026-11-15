import { randomUUID } from "node:crypto";
import type { SeatOperation } from "@openorc/protocol";
import type { WireOrganizationBilling } from "../organization-billing-wire.js";

type Reply = { status: number; body: unknown };
type Billing = WireOrganizationBilling;
type Subscription = NonNullable<Billing["subscription"]>;
type Price = { amount: number; currency: string } | null;
type Review = { spaceId: string; actor: string; revision: string; to: number; expires: number; used: boolean };
const reply = (status: number, body: unknown): Reply => ({ status, body });
const refuse = (status: number, message: string): Reply => reply(status, { statusCode: status, message });
const CHANGED = "The seats have changed. Review the change again.";
const PAYMENT = "The payment for these seats didn't go through. Update the payment method in billing and try again.";
const MONTH_SECONDS = 360_000;

interface Deps {
  records: Map<string, Billing>;
  prices(): Record<"monthly" | "yearly", Price>;
  now(): number;
  changed(spaceId: string): void;
}

/** Changing an organization's number of seats, as the seats contract's unit 6 words it. */
export class StandInSeatQuantity {
  /** A confirmed change stays pending, as while a payment or the provider is still being heard. */
  pending = false;
  /** The provider refuses the payment for more seats. */
  refusePayment = false;
  /** A server from before it said what a seat gets at renewal or why an operation failed. */
  plain = false;
  readonly #reviews = new Map<string, Review>();
  readonly #operations = new Map<string, { spaceId: string; token: string; to: number; operation: SeatOperation }>();
  constructor(private readonly deps: Deps) {}

  route(method: string, path: string, spaceId: string, actor: string, body: unknown): Reply | null {
    if (method === "POST" && path === "/organization/billing/quantity/preview") return this.#preview(spaceId, actor, body);
    if (method === "PATCH" && path === "/organization/billing/quantity") return this.#confirm(spaceId, actor, body);
    const read = method === "GET" ? /^\/organization\/billing\/operations\/([^/]+)$/.exec(path) : null;
    const saved = read ? this.#operations.get(decodeURIComponent(read[1]!)) : undefined;
    return saved?.spaceId === spaceId ? reply(200, saved.operation) : null;
  }

  /** A pending change is heard from the provider: its seats appear or go, and it reads complete. */
  settle(id: string): void {
    const saved = this.#operations.get(id);
    const billing = saved && this.deps.records.get(saved.spaceId);
    if (!saved || !billing?.subscription || saved.operation.state !== "pending") return;
    this.#apply(billing, billing.subscription, saved.to);
    saved.operation = { ...saved.operation, state: "complete", message: null };
    this.deps.changed(saved.spaceId);
  }

  #preview(spaceId: string, actor: string, body: unknown): Reply {
    const seats = (body as { seats?: unknown } | null)?.seats;
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 0 || seats > 100) return refuse(400, "Choose a number of seats from 0 to 100.");
    const billing = this.deps.records.get(spaceId);
    const subscription = billing?.subscription;
    if (!billing || !subscription) return refuse(404, "This organization hasn't bought seats yet, so there is no billing to manage.");
    const refusal = this.#refusal(billing, subscription, seats);
    if (refusal) return refusal;
    const now = this.deps.now();
    const paidEnd = Date.parse(subscription.paidUntil ?? new Date(now).toISOString());
    const token = randomUUID();
    const expires = Math.min(now + 60_000, paidEnd > now ? paidEnd : now + 60_000);
    this.#reviews.set(token, { spaceId, actor, revision: billing.revision, to: seats, expires, used: false });
    const later = seats < subscription.quantity;
    const unit = this.deps.prices()[subscription.plan];
    return reply(200, {
      token,
      expiresAt: new Date(expires).toISOString(),
      asOf: new Date(now).toISOString(),
      from: subscription.quantity,
      to: seats,
      effect: later ? "renewal" : "now",
      at: new Date(later ? paidEnd : now).toISOString(),
      nextPrice: unit && { amount: unit.amount * seats, currency: unit.currency },
      ...this.#added(billing, subscription, seats, unit),
      ...this.#renewal(billing, seats),
    });
  }

  /** What each seat is given when its hours next renew, and when; nothing once no seat is left. */
  #renewal(billing: Billing, seats: number) {
    if (this.plain) return {};
    const endsAt = billing.seats.find((seat) => seat.period)?.period?.endsAt ?? null;
    return seats > 0 ? { renewalGrantSecondsPerSeat: 360_000, renewalGrantAt: endsAt } : { renewalGrantSecondsPerSeat: 0, renewalGrantAt: null };
  }

  /** What more seats cost now and bring, by the part of the hours' month that is left; nothing for any other change. */
  #added(billing: Billing, subscription: Subscription, seats: number, unit: Price) {
    const period = billing.seats.find((seat) => seat.period)?.period ?? null;
    if (seats <= subscription.quantity || !period) return { estimatedChargeNow: null, firstGrantSecondsPerNewSeat: 0, firstGrantEndsAt: null };
    const left = monthLeft(period, this.deps.now());
    return {
      estimatedChargeNow: unit && { amount: Math.round(unit.amount * (seats - subscription.quantity) * left), currency: unit.currency },
      firstGrantSecondsPerNewSeat: partGrant(left),
      firstGrantEndsAt: period.endsAt,
    };
  }

  #refusal(billing: Billing, subscription: Subscription, seats: number): Reply | null {
    if (subscription.standing === "grace") return refuse(402, PAYMENT);
    if (subscription.standing === "ended") return refuse(409, CHANGED);
    const ending = subscription.standing === "ending";
    if (ending && seats > 0 && seats !== subscription.quantity) return refuse(409, `These seats are ending. Set them back to ${subscription.quantity} to keep them, then change the number.`);
    const scheduled = subscription.pendingQuantity?.quantity ?? (ending ? 0 : null);
    if (seats === scheduled || (seats === subscription.quantity && scheduled === null)) return refuse(409, CHANGED);
    const occupied = billing.seats.filter((seat) => seat.assignment.kind !== "available").length;
    if (seats > 0 && seats < occupied) return refuse(409, "Take back seats or revoke their invitations before reducing the number of seats.");
    return null;
  }

  #confirm(spaceId: string, actor: string, body: unknown): Reply {
    const { id, previewToken: token } = (body ?? {}) as { id?: unknown; previewToken?: unknown };
    if (typeof id !== "string" || typeof token !== "string") return refuse(400, "Review the seat change before sending it.");
    const saved = this.#operations.get(id);
    if (saved) return saved.token === token && saved.spaceId === spaceId ? answered(saved.operation) : refuse(409, "That change was already sent with different details. Read the seats again.");
    const billing = this.deps.records.get(spaceId);
    const subscription = billing?.subscription;
    const review = this.#usable(token, spaceId, actor);
    if (!review || !billing || !subscription || review.revision !== billing.revision) return refuse(409, CHANGED);
    const refusal = this.#refusal(billing, subscription, review.to);
    if (refusal) return refusal;
    review.used = true;
    const state = this.#outcome(review.to > subscription.quantity);
    const message = { failed: PAYMENT, pending: "Updating seats.", complete: null }[state];
    const operation: SeatOperation = { id, kind: "quantity", state, message, ...(!this.plain && { code: state === "failed" ? "payment_refused" : null }) };
    this.#operations.set(id, { spaceId, token, to: review.to, operation });
    if (state === "complete") this.#apply(billing, subscription, review.to);
    this.deps.changed(spaceId);
    return answered(operation);
  }

  /** The review a confirmation may still use: this admin's, for this organization, unexpired, unused, with no other change being settled. */
  #usable(token: string, spaceId: string, actor: string): Review | null {
    const review = this.#reviews.get(token);
    const unsettled = [...this.#operations.values()].some((each) => each.spaceId === spaceId && each.operation.state === "pending");
    const usable = review && !review.used && !unsettled && review.spaceId === spaceId && review.actor === actor && review.expires > this.deps.now();
    return usable ? review : null;
  }

  #outcome(more: boolean): SeatOperation["state"] {
    if (more && this.refusePayment) return "failed";
    return this.pending ? "pending" : "complete";
  }

  /** More seats appear free with a part month's hours; fewer are held back until renewal; none ends the subscription then. */
  #apply(billing: Billing, subscription: Subscription, to: number): void {
    const now = this.deps.now();
    const at = subscription.paidUntil ?? new Date(now).toISOString();
    for (const seat of billing.seats) seat.retiresAt = null;
    subscription.pendingQuantity = null;
    if (subscription.standing === "ending") subscription.standing = "live";
    if (to > subscription.quantity) {
      const period = billing.seats.find((seat) => seat.period)?.period ?? null;
      const granted = period ? partGrant(monthLeft(period, now)) : 0;
      for (let index = subscription.quantity; index < to; index++)
        billing.seats.push({
          id: `seat-added-${randomUUID().slice(0, 8)}`,
          assignment: { kind: "available" },
          period,
          included: { grantedSeconds: granted, usedSeconds: 0, leftSeconds: granted },
          retiresAt: null,
        });
      subscription.quantity = to;
    } else if (to === 0) {
      subscription.standing = "ending";
      subscription.pendingQuantity = { quantity: 0, at };
    } else if (to < subscription.quantity) {
      const leaving = billing.seats.filter((seat) => seat.assignment.kind === "available").slice(-(subscription.quantity - to));
      for (const seat of leaving) seat.retiresAt = at;
      subscription.pendingQuantity = { quantity: to, at };
    }
    billing.revision = randomUUID();
    billing.available = billing.seats.filter((seat) => seat.assignment.kind === "available" && seat.retiresAt === null).length;
  }
}

const answered = (operation: SeatOperation): Reply => reply(operation.state === "pending" ? 202 : 200, operation);
/** The fraction of the hours' month still to run. */
const monthLeft = (period: { startsAt: string; endsAt: string }, now: number): number => Math.max(0, Date.parse(period.endsAt) - now) / (Date.parse(period.endsAt) - Date.parse(period.startsAt));
/** A new seat's hours for the rest of the month: the fraction of 100 hours, down to a whole minute. */
const partGrant = (left: number): number => Math.min(MONTH_SECONDS, Math.floor((MONTH_SECONDS * left) / 60) * 60);
