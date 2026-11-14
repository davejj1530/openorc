import { OrganizationBillingPage, type OrganizationBilling, type OrganizationPayment } from "@openorc/protocol";
import { z } from "zod";
import { Refused } from "./session.js";

export const organizationPaymentRecord = z.object({
  id: z.uuid(),
  target: OrganizationBillingPage,
  since: z.number(),
  before: z.string(),
  outcome: z.discriminatedUnion("state", [
    z.object({ state: z.literal("pending"), error: z.string().nullable() }),
    z.object({ state: z.literal("waiting"), url: z.url(), error: z.string().nullable() }),
    z.object({ state: z.literal("complete"), error: z.null() }),
    z.object({ state: z.literal("failed"), error: z.string() }),
  ]),
});
export type OrganizationPaymentRecord = z.infer<typeof organizationPaymentRecord>;

export interface OrganizationPaymentDeps {
  now(): number;
  browser?: { open(url: string): void };
  load(): OrganizationPaymentRecord | null;
  save(record: OrganizationPaymentRecord): void;
  current(): boolean;
  billing(): OrganizationBilling | null;
  link(target: OrganizationBillingPage): Promise<{ url: string }>;
  reread(): Promise<void>;
  changed(): void;
}

export class OrganizationBillingPayment {
  #starting: Promise<void> | null = null;
  #watch: { read: ReturnType<typeof setTimeout> | null; ends: ReturnType<typeof setTimeout> } | null = null;
  #closed = false;
  constructor(private readonly deps: OrganizationPaymentDeps) {}

  get work(): OrganizationPayment | null {
    if (!this.#current()) return null;
    const record = this.deps.load();
    if (!record) return null;
    const work = { id: record.id, target: record.target, since: record.since, watching: this.#watch !== null };
    return record.outcome.state === "failed" ? { ...work, ...record.outcome } : { ...work, state: record.outcome.state, error: record.outcome.error };
  }

  /** Only a person's press calls this method; polling never creates or retries a checkout. */
  async open(target: OrganizationBillingPage): Promise<void> {
    if (!this.deps.browser) throw new Error("This device can't open the payment page.");
    if (!this.#current()) return;
    if (this.#starting) return this.#starting;
    const record = this.deps.load();
    if (record?.outcome.state === "complete" && target.page === "checkout" && this.deps.billing()?.subscription?.standing !== "ended") return;
    const starting = this.#begin(target, record);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  async #begin(target: OrganizationBillingPage, previous: OrganizationPaymentRecord | null): Promise<void> {
    const held = previous && (previous.outcome.state === "pending" || (previous.outcome.state === "waiting" && JSON.stringify(previous.target) === JSON.stringify(target))) ? previous : null;
    const record = held ?? {
      id: crypto.randomUUID(),
      target: structuredClone(target),
      since: this.deps.now(),
      before: JSON.stringify(this.deps.billing()?.subscription ?? null),
      outcome: { state: "pending", error: null } as const,
    };
    if (!held) this.deps.save(record);
    const reopening = this.#watch !== null;
    this.#startWatch();
    if (reopening && record.outcome.state === "waiting") return this.#present(record, record.outcome.url);
    // A stopped watch can outlive a terminal unpaid checkout. A new press asks the server to reconcile it.
    await this.#request(record);
  }

  async #request(record: OrganizationPaymentRecord): Promise<void> {
    let link: { url: string };
    try {
      link = await this.deps.link(record.target);
    } catch (error) {
      await this.#refused(record, error);
      return;
    }
    if (!this.#stillPending(record)) return;
    this.#save(record, { state: "waiting", url: link.url, error: null });
    if (this.#watch) this.#present(record, link.url);
  }

  #present(record: OrganizationPaymentRecord, url: string): void {
    if (!this.#stillPending(record)) return;
    try {
      this.deps.browser?.open(url);
      this.#save(record, { state: "waiting", url, error: null });
    } catch (error) {
      this.#save(record, { state: "waiting", url, error: words(error) });
    }
  }

  async #refused(record: OrganizationPaymentRecord, error: unknown): Promise<void> {
    if (!this.#stillPending(record)) return;
    if (alreadyPaid(record.target, error)) {
      this.#complete(record);
      await this.deps.reread().catch(() => undefined);
      return;
    }
    const failed = error instanceof Refused && error.code !== "organization_payment_pending" && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408;
    this.#save(record, { state: failed ? "failed" : "pending", error: words(error) });
    if (failed) this.leave();
  }

  heard(billing: OrganizationBilling): void {
    if (!this.#current()) return;
    const record = this.deps.load();
    if (!record || !["pending", "waiting"].includes(record.outcome.state)) return;
    const landed = record.target.page === "checkout" ? billing.subscription !== null && billing.subscription.standing !== "ended" : JSON.stringify(billing.subscription) !== record.before;
    if (landed) this.#complete(record);
  }

  #complete(record: OrganizationPaymentRecord): void {
    this.#save(record, { state: "complete", error: null });
    this.leave();
  }

  #save(record: OrganizationPaymentRecord, outcome: OrganizationPaymentRecord["outcome"]): void {
    this.deps.save({ ...record, outcome });
    this.deps.changed();
  }

  leave(): void {
    if (this.#watch?.read) clearTimeout(this.#watch.read);
    if (this.#watch) clearTimeout(this.#watch.ends);
    this.#watch = null;
    this.deps.changed();
  }

  close(): void {
    this.#closed = true;
    this.leave();
  }

  #startWatch(): void {
    if (this.#watch) return;
    this.#watch = { read: null, ends: setTimeout(() => this.leave(), 15 * 60_000) };
    this.#next();
    this.deps.changed();
  }

  #next(): void {
    const watch = this.#watch;
    if (!watch) return;
    watch.read = setTimeout(() => {
      if (!this.#current() || this.#watch !== watch) return;
      void this.deps
        .reread()
        .catch(() => undefined)
        .finally(() => {
          if (this.#watch === watch) this.#next();
        });
    }, 10_000);
  }

  #current(): boolean {
    return !this.#closed && this.deps.current();
  }

  #stillPending(record: OrganizationPaymentRecord): boolean {
    const current = this.deps.load();
    return this.#current() && current?.id === record.id && ["pending", "waiting"].includes(current.outcome.state);
  }
}

function alreadyPaid(target: OrganizationBillingPage, error: unknown): boolean {
  return target.page === "checkout" && error instanceof Refused && error.status === 409 && error.message === "This organization already pays for seats. Change the number of seats in billing.";
}

const words = (error: unknown) => (error instanceof Error ? error.message : "The payment page could not be opened.");
