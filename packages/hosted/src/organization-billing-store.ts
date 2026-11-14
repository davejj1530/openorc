import { z } from "zod";
import { organizationPaymentRecord, type OrganizationPaymentRecord } from "./organization-billing-payment.js";

const scope = z.object({ origin: z.string(), userId: z.string(), spaceId: z.string() });
export type OrganizationBillingScope = z.infer<typeof scope>;
const records = z.array(scope.extend({ payment: organizationPaymentRecord }));
export interface OrganizationBillingStorage {
  load(): string | null;
  save(value: string): void;
}
export const organizationBillingKey = (value: OrganizationBillingScope): string => JSON.stringify([value.origin, value.userId, value.spaceId]);

/** Keep unresolved requests apart from disposable admin snapshots and from other accounts. */
export class OrganizationBillingStore {
  constructor(private readonly storage: OrganizationBillingStorage) {}
  #records() {
    const value = this.storage.load();
    if (value === null) return [];
    try {
      return records.parse(JSON.parse(value));
    } catch {
      throw new Error("Saved payment requests could not be read. Restart OpenOrc before opening another payment page.");
    }
  }
  load(scope: OrganizationBillingScope): OrganizationPaymentRecord | null {
    const key = organizationBillingKey(scope);
    return this.#records().find((record) => organizationBillingKey(record) === key)?.payment ?? null;
  }
  save(scope: OrganizationBillingScope, payment: OrganizationPaymentRecord): void {
    const key = organizationBillingKey(scope);
    const others = this.#records().filter((record) => organizationBillingKey(record) !== key);
    this.storage.save(JSON.stringify([...others, { ...scope, payment }]));
  }
}
