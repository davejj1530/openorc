/**
 * Paying, through pages of Polar's that the server makes for the person and this device opens in the browser. The
 * address goes to the browser and nowhere else. No page comes back to the app: the server sends the `billing` topic
 * when Polar tells it, and while a page is open its part of the account is also read every READ_MS, since one missed
 * topic would otherwise leave the purchase unseen until the next.
 *
 * State, written only here:
 *   open    the page opened last, when, and billing as heard then; null once what it was for lands, the person leaves
 *           the screen they paid from, OPEN_MS pass, or they sign out
 */
import type { BillingPage, Paying as PayingWork } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import type { Session } from "./session.js";
import { ROUTES, type WireBilling } from "./wire.js";

const READ_MS = 10_000;
/** Longer than anyone takes over a checkout; after it, only the server's topic tells of a purchase. */
const OPEN_MS = 15 * 60_000;
const NO_BROWSER = "This device can't open the payment page.";

type Page = BillingPage["page"];

/** Whether billing, as heard now, shows what a page was for, against billing as heard when it opened. */
const LANDED: Record<Page, (before: WireBilling | null, now: WireBilling) => boolean> = {
  pro: (_before, now) => now.pro.status === "pro" && now.pro.paidBy.kind === "self" && now.pro.standing !== "grace",
  hours: (before, now) => now.packs.some((pack) => !before?.packs.some((had) => had.boughtAt === pack.boughtAt)),
  billing: (before, now) => JSON.stringify(now.pro) !== JSON.stringify(before?.pro),
};

interface PayingDeps extends Pick<HostedDeps, "browser" | "now"> {
  session: Session;
  /** Billing as the account last heard it. */
  billing(): WireBilling | null;
  /** Reads billing again; the account hands the answer to `heard`. */
  reread(): Promise<void>;
  /** The work changed: the windows read the account again. */
  changed(): void;
}

export class Paying {
  #open: { target: BillingPage; url: string; since: number; before: WireBilling | null; read: ReturnType<typeof setTimeout> | null; ends: ReturnType<typeof setTimeout> } | null = null;
  #starting: Promise<void> | null = null;
  #generation = 0;

  constructor(private readonly deps: PayingDeps) {}

  get work(): PayingWork | null {
    return this.#open && { ...this.#open.target, since: this.#open.since };
  }

  /** Resolves once the page is open in the browser; rejects in the server's words when it will not make one. */
  async open(page: BillingPage): Promise<void> {
    const browser = this.deps.browser;
    if (!browser) throw new Error(NO_BROWSER);
    if (this.#open?.target.page === page.page) {
      browser.open(this.#open.url);
      return;
    }
    if (this.#starting) return this.#starting;
    const starting = this.#begin(page, this.#generation);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  async #begin(page: BillingPage, generation: number): Promise<void> {
    const link =
      page.page === "pro" ? await this.deps.session.request(ROUTES.checkoutPro, { plan: page.period }) : await this.deps.session.request(page.page === "hours" ? ROUTES.checkoutHours : ROUTES.portal);
    if (generation !== this.#generation) return;
    this.deps.browser!.open(link.url);
    // Only now is the page before it given up: a page the server refused leaves the one being waited on watched.
    this.#stop();
    this.#open = { target: page, url: link.url, since: this.deps.now(), before: this.deps.billing(), read: null, ends: setTimeout(() => this.leave(), OPEN_MS) };
    this.#next();
    this.deps.changed();
  }

  /** The person left the screen they paid from. */
  leave(): void {
    if (this.#stop()) this.deps.changed();
  }

  /** Billing was heard: an open page whose purchase shows in it is done. */
  heard(billing: WireBilling): void {
    if (this.#open && LANDED[this.#open.target.page](this.#open.before, billing)) this.leave();
  }

  /** Signed out: nothing of it is remembered. */
  forget(): void {
    this.#stop();
  }

  #next(): void {
    const open = this.#open;
    if (!open) return;
    open.read = setTimeout(() => {
      if (this.#open !== open) return;
      void this.deps.reread().finally(() => {
        if (this.#open === open) this.#next();
      });
    }, READ_MS);
  }

  #stop(): boolean {
    this.#generation++;
    this.#starting = null;
    if (!this.#open) return false;
    if (this.#open.read) clearTimeout(this.#open.read);
    clearTimeout(this.#open.ends);
    this.#open = null;
    return true;
  }
}
