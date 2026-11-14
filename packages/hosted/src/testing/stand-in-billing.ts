/**
 * The stand-in's billing: what each person has, and the server's checkout and portal routes as apps call them. Polar
 * is not stood in for: a checkout's page is an address nothing serves, and `pay` is Polar telling the server a page
 * was paid, after which the server tells the person's apps on the `billing` topic, as its webhooks do.
 *
 * The real server's rules kept here:
 *   POST /billing/checkout/pro    takes `{ plan }` of monthly or yearly; 409 for a person who already pays for Pro
 *   POST /billing/checkout/hours  409 for a person who is not Pro
 *   POST /billing/portal          404 for a person who never bought anything
 *   GET /billing/offers           what Pro and a pack cost, a price null where Polar has no single amount; 503 in words
 *                                 where billing is not set up
 */
import { randomUUID } from "node:crypto";
import type { WireBilling } from "../wire.js";

/** `bought`: when each hours pack was bought, every one of them unused, beside `packsLeftSeconds` of one bought earlier. */
export type StandInBilling = (
  | { pro: false; packsLeftSeconds?: number; bought?: string[] }
  | { pro: true; standing: "live" | "ending" | "grace"; at: string; monthlyLeftSeconds: number | null; packsLeftSeconds: number; bought?: string[] }
) & {
  organizationAccess?: WireBilling["organizationAccess"];
  allowanceSource?: WireBilling["allowanceSource"];
  paidBy?: Extract<WireBilling["pro"], { status: "pro" }>["paidBy"];
};

const MONTH_SECONDS = 40 * 3600;
const PACK_SECONDS = 20 * 3600;
const DAY_MS = 86_400_000;
const PLANS = ["monthly", "yearly"];
const NOT_SET_UP = "Billing isn't set up on this server, so Pro and hours can't be bought here yet.";

/** What GET /billing/offers answers: amounts in the currency's smallest unit. */
export type StandInOffers = {
  monthlySeconds: number;
  pro: { plan: string; price: { amount: number; currency: string } | null }[];
  hours: { seconds: number; months: number; price: { amount: number; currency: string } | null };
};
const OFFERS: StandInOffers = {
  monthlySeconds: 100 * 3600,
  pro: [
    { plan: "monthly", price: { amount: 2000, currency: "usd" } },
    { plan: "yearly", price: { amount: 20000, currency: "usd" } },
  ],
  hours: { seconds: PACK_SECONDS, months: 12, price: { amount: 1000, currency: "usd" } },
};

type Reply = { status: number; body: unknown };
const refused = (status: number, message: string): Reply => ({ status, body: { statusCode: status, message } });

function paysOwnPro(state: StandInBilling): boolean {
  return state.pro && (state.paidBy?.kind ?? state.allowanceSource?.kind ?? "self") === "self" && state.standing !== "grace";
}

/** Hours a person can use, as the server counts them before a turn. */
export function leftSeconds(state: StandInBilling): number {
  const monthly = state.pro && state.standing !== "grace" ? (state.monthlyLeftSeconds ?? 0) : 0;
  return monthly + (state.packsLeftSeconds ?? 0) + (state.bought?.length ?? 0) * PACK_SECONDS;
}

export class StandInPayments {
  /** Every checkout made, in order, by person, with the address the app was given. */
  readonly checkouts: { who: string; page: "pro" | "hours"; plan: string | null; url: string }[] = [];
  readonly #customers = new Set<string>();
  /** Null: billing is not set up. */
  offers: StandInOffers | null = OFFERS;

  constructor(
    private readonly billing: Map<string, StandInBilling>,
    /** Tells the person's apps topics of theirs changed. */
    private readonly tell: (who: string, topics: string[]) => void,
    private readonly origin: () => string,
  ) {}

  route(method: string, path: string, who: string, body: Record<string, unknown>): Reply | null {
    if (method === "GET" && path === "/billing/offers") return this.offers ? { status: 200, body: this.offers } : refused(503, NOT_SET_UP);
    if (method !== "POST") return null;
    const state = this.billing.get(who) ?? { pro: false };
    if (path === "/billing/checkout/pro") {
      if (!PLANS.includes(String(body["plan"]))) return refused(400, "Choose monthly or yearly.");
      if (paysOwnPro(state)) return refused(409, "You already pay for Pro. Change your plan in billing.");
      return this.#checkout(who, "pro", String(body["plan"]));
    }
    if (path === "/billing/checkout/hours") return state.pro ? this.#checkout(who, "hours", null) : refused(409, "Hours packs are for Pro. Upgrade to Pro first.");
    if (path === "/billing/portal") {
      if (!this.#customers.has(who)) return refused(404, "You haven't bought anything yet, so there is no billing to manage.");
      return { status: 200, body: { url: `${this.origin()}/stand-in/portal/${randomUUID()}` } };
    }
    return null;
  }

  /** The person pays on the last checkout opened for them. Their apps hear of it unless `quiet`, as when the topic is lost. */
  pay(who: string, options: { quiet?: boolean } = {}): void {
    const checkout = this.checkouts.findLast((each) => each.who === who);
    if (!checkout) throw new Error(`No checkout was opened for ${who}.`);
    const now = Date.now();
    const state = this.billing.get(who) ?? { pro: false };
    if (checkout.page === "pro")
      this.billing.set(who, {
        pro: true,
        standing: "live",
        at: new Date(now + 30 * DAY_MS).toISOString(),
        monthlyLeftSeconds: MONTH_SECONDS,
        packsLeftSeconds: state.packsLeftSeconds ?? 0,
        ...(state.bought && { bought: state.bought }),
        ...(state.allowanceSource !== undefined && { allowanceSource: { kind: "self" } }),
        ...(state.organizationAccess !== undefined && { organizationAccess: { state: "active", reason: null, until: null, message: null } }),
      });
    else if (state.pro) this.billing.set(who, { ...state, bought: [...(state.bought ?? []), new Date(now).toISOString()] });
    this.#customers.add(who);
    if (!options.quiet) this.tell(who, ["billing"]);
  }

  #checkout(who: string, page: "pro" | "hours", plan: string | null): Reply {
    const url = `${this.origin()}/stand-in/checkout/${randomUUID()}`;
    this.checkouts.push({ who, page, plan, url });
    return { status: 200, body: { url } };
  }
}

/** The billing state the real server answers, built from the few facts a test sets. */
export function billingState(state: StandInBilling) {
  const privateFacts = {
    ...(state.organizationAccess !== undefined && { organizationAccess: state.organizationAccess }),
    ...(state.allowanceSource !== undefined && { allowanceSource: state.allowanceSource }),
  };
  const packs = billingPacks(state);
  if (!state.pro) return { pro: { status: "free" }, period: null, monthly: null, packs, leftSeconds: leftSeconds(state), ...privateFacts };
  const end = Date.parse(state.at);
  const paidBy = state.paidBy ?? (state.allowanceSource?.kind === "organization" ? { kind: "organization", organizationId: state.allowanceSource.organizationId } : { kind: "self" });
  const pro = state.standing === "live" ? { status: "pro", standing: "live", renewsAt: state.at, paidBy } : { status: "pro", standing: state.standing, until: state.at, paidBy };
  const monthly =
    state.monthlyLeftSeconds === null || state.standing === "grace"
      ? null
      : { grantedSeconds: MONTH_SECONDS, usedSeconds: MONTH_SECONDS - state.monthlyLeftSeconds, leftSeconds: state.monthlyLeftSeconds };
  return { pro, period: { startsAt: new Date(end - 30 * DAY_MS).toISOString(), endsAt: state.at }, monthly, packs, leftSeconds: leftSeconds(state), ...privateFacts };
}

function billingPacks(state: StandInBilling) {
  const pack = (left: number, boughtAt: number) => ({
    grantedSeconds: PACK_SECONDS,
    usedSeconds: PACK_SECONDS - left,
    leftSeconds: left,
    boughtAt: new Date(boughtAt).toISOString(),
    expiresAt: new Date(boughtAt + 365 * DAY_MS).toISOString(),
  });
  const end = state.pro ? Date.parse(state.at) : Date.now();
  const left = state.packsLeftSeconds ?? 0;
  return [...(left > 0 ? [pack(left, end - DAY_MS)] : []), ...(state.bought ?? []).map((at) => pack(PACK_SECONDS, Date.parse(at)))];
}
