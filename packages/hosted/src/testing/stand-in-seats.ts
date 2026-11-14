import { OrganizationBillingPage, type OrganizationBillingOffers } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { WireOrganizationBilling } from "../organization-billing-wire.js";
import type { StandInSpaces } from "./stand-in-spaces.js";

type Request = { method: string; path: string; query: URLSearchParams; space: string | null };
type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (status: number, message: string): Reply => ({ status, body: { message } });
type Checkout = { spaceId: string; plan: "monthly" | "yearly"; seats: number; url: string; expiresAt: string; state: "pending" | "paid" | "expired" };
interface Dependencies {
  spaces: StandInSpaces;
  now(): number;
  origin(): string;
  tell(who: string, topics: string[], spaceId: string): void;
}

/** Loopback capacity is created only by paid confirmation; a return alone does not settle a checkout. */
export class StandInSeats {
  enabled = false;
  configured = true;
  readonly checkouts: Checkout[] = [];
  readonly records = new Map<string, WireOrganizationBilling>();
  prices: Record<"monthly" | "yearly", { amount: number; currency: string } | null> = { monthly: { amount: 2000, currency: "usd" }, yearly: { amount: 20000, currency: "usd" } };
  constructor(private readonly deps: Dependencies) {}

  seed(spaceId: string, values: Partial<WireOrganizationBilling> = {}): WireOrganizationBilling {
    const team = this.deps.spaces.teams.get(spaceId);
    if (!team) throw new Error("The organization does not exist.");
    const record: WireOrganizationBilling = {
      organization: { id: spaceId, name: team.name, logo: team.logo },
      revision: randomUUID(),
      asOf: this.#now(),
      subscription: null,
      seats: [],
      available: 0,
      ...values,
    };
    this.records.set(spaceId, record);
    return record;
  }

  route(request: Request, who: string, body: unknown): Reply | null {
    if (!/^\/organization\/billing(?:\/|$)/.test(request.path)) return null;
    if (!this.enabled) return refused(404, "Not found.");
    const spaceId = request.space;
    if (!spaceId) return refused(400, "Name the space in x-openorc-space.");
    const resolved = this.deps.spaces.resolve(who, spaceId);
    if (typeof resolved !== "string") return resolved;
    if (!this.deps.spaces.teams.has(spaceId)) return refused(409, "Your personal space has no organization seats. Manage your own Pro in Account.");
    if (this.deps.spaces.member(spaceId, who)?.role !== "admin") return refused(403, "Only an admin can do that.");
    if (request.method === "GET") return this.#get(request, spaceId);
    if (request.method === "POST" && request.path === "/organization/billing/checkout") return this.#checkout(spaceId, body);
    if (request.method === "POST" && request.path === "/organization/billing/portal") return this.#portal(spaceId);
    return refused(404, "Not found.");
  }

  #get(request: Request, spaceId: string): Reply {
    if (request.path === "/organization/billing") return ok({ ...(this.records.get(spaceId) ?? this.seed(spaceId)), asOf: this.#now() });
    if (request.path !== "/organization/billing/offers") return refused(404, "Not found.");
    const seats = Number(request.query.get("seats"));
    if (!Number.isInteger(seats) || seats < 1 || seats > 100) return refused(400, "Choose a number of seats from 1 to 100.");
    if (!this.configured) return this.#notConfigured();
    const offers: OrganizationBillingOffers = {
      offers: (["monthly", "yearly"] as const).map((plan) => ({ plan, seats, price: this.prices[plan] && { ...this.prices[plan], amount: this.prices[plan].amount * seats } })),
      monthlySeconds: 360000,
      maxSeats: 100,
    };
    return ok(offers);
  }

  #checkout(spaceId: string, body: unknown): Reply {
    const parsed = OrganizationBillingPage.options[0].omit({ page: true }).safeParse(body);
    if (!parsed.success) return refused(400, "Choose a number of seats from 1 to 100.");
    if (!this.configured) return this.#notConfigured();
    const subscription = this.records.get(spaceId)?.subscription;
    if (subscription && subscription.standing !== "ended") return refused(409, "This organization already pays for seats. Change the number of seats in billing.");
    const pending = this.checkouts.find((checkout) => checkout.spaceId === spaceId && checkout.state === "pending");
    if (pending) return this.#pending(pending, parsed.data);
    const checkout: Checkout = {
      spaceId,
      ...parsed.data,
      url: `${this.deps.origin()}/stand-in/organization-checkout/${randomUUID()}`,
      expiresAt: new Date(this.deps.now() + 86_400_000).toISOString(),
      state: "pending",
    };
    this.checkouts.push(checkout);
    return ok({ url: checkout.url });
  }

  #pending(checkout: Checkout, requested: { plan: "monthly" | "yearly"; seats: number }): Reply {
    Object.assign(checkout, requested);
    return ok({ url: checkout.url });
  }

  #portal(spaceId: string): Reply {
    if (!this.records.get(spaceId)?.subscription) return refused(404, "This organization hasn't bought seats yet, so there is no billing to manage.");
    return ok({ url: `${this.deps.origin()}/stand-in/organization-portal/${encodeURIComponent(spaceId)}` });
  }

  expire(spaceId: string): void {
    const checkout = this.checkouts.findLast((item) => item.spaceId === spaceId && item.state === "pending");
    if (checkout) checkout.state = "expired";
  }

  /** The fixture's payment service confirms payment, with no implicit holder and no need for a webhook. */
  pay(spaceId: string, options: { quiet?: boolean } = {}): void {
    const checkout = this.checkouts.findLast((item) => item.spaceId === spaceId && item.state === "pending");
    if (!checkout) throw new Error("No pending organization checkout.");
    checkout.state = "paid";
    const now = this.deps.now();
    const month = 30 * 86_400_000;
    const period = { startsAt: new Date(now).toISOString(), endsAt: new Date(now + month).toISOString() };
    this.seed(spaceId, {
      subscription: {
        id: randomUUID(),
        plan: checkout.plan,
        standing: "live",
        paidUntil: new Date(now + (checkout.plan === "yearly" ? 12 : 1) * month).toISOString(),
        graceUntil: null,
        quantity: checkout.seats,
        overallocated: false,
        pendingQuantity: null,
      },
      seats: [
        ...(this.records.get(spaceId)?.seats ?? []),
        ...Array.from({ length: checkout.seats }, () => ({
          id: randomUUID(),
          assignment: { kind: "available" as const },
          period,
          included: { grantedSeconds: 360000, usedSeconds: 0, leftSeconds: 360000 },
          retiresAt: null,
        })),
      ],
      available: checkout.seats,
    });
    if (!options.quiet) for (const who of this.deps.spaces.readers(spaceId)) this.deps.tell(who, ["billing"], spaceId);
  }

  #now(): string {
    return new Date(this.deps.now()).toISOString();
  }
  #notConfigured(): Reply {
    return refused(503, "Billing isn't set up on this server, so Pro and hours can't be bought here yet.");
  }
}
