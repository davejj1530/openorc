import { expect, it } from "vitest";
import { OrganizationBillingStore } from "./organization-billing-store.js";
import type { OrganizationPaymentRecord } from "./organization-billing-payment.js";

const scope = { origin: "https://example.com", userId: "person-a", spaceId: "team-a" };
const payment: OrganizationPaymentRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  target: { page: "checkout", plan: "monthly", seats: 3 },
  since: 1000,
  before: "null",
  outcome: { state: "pending", error: null },
};

it("keeps the exact pending request across restart, separated by origin, person and organization", () => {
  let value: string | null = null;
  const storage = {
    load: () => value,
    save: (next: string) => {
      value = next;
    },
  };
  new OrganizationBillingStore(storage).save(scope, payment);
  const store = new OrganizationBillingStore(storage);
  expect(store.load(scope)).toEqual(payment);
  expect(store.load({ ...scope, spaceId: "team-b" })).toBeNull();
  expect(store.load({ ...scope, userId: "person-b" })).toBeNull();
  expect(store.load({ ...scope, origin: "https://other.example.com" })).toBeNull();
  store.save({ ...scope, spaceId: "team-b" }, { ...payment, target: { page: "checkout", plan: "yearly", seats: 5 } });
  expect(store.load(scope)).toEqual(payment);
});

it("does not turn unreadable durable requests into a fresh purchase", () => {
  const store = new OrganizationBillingStore({
    load: () => "not-json",
    save: () => {
      throw new Error("Should not save.");
    },
  });
  expect(() => store.load(scope)).toThrow("Saved payment requests could not be read.");
  expect(() => store.save(scope, payment)).toThrow("Saved payment requests could not be read.");
});
