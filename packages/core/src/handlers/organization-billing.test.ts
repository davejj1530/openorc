import { expect, it, vi } from "vitest";
import type { OrganizationBillingPage, OrganizationBillingStatus } from "@openorc/protocol";
import { createOrganizationBillingHandlers } from "./organization-billing.js";

it("binds every billing action to the supplied organization", async () => {
  const status: OrganizationBillingStatus = { billing: null, payment: null, error: null };
  const service = { read: vi.fn(async () => status), offers: vi.fn(async () => ({ offers: [], monthlySeconds: 360000, maxSeats: 100 })), open: vi.fn(async () => status), leave: vi.fn(() => status) };
  const handlers = createOrganizationBillingHandlers(service);
  const target: OrganizationBillingPage = { page: "checkout", plan: "yearly", seats: 3 };
  await handlers["organization.billing.get"]({ spaceId: "team-a" });
  await handlers["organization.billing.offers"]({ spaceId: "team-b", seats: 3 });
  await handlers["organization.billing.open"]({ spaceId: "team-a", target });
  await handlers["organization.billing.leave"]({ spaceId: "team-b" });
  expect(service.read).toHaveBeenCalledExactlyOnceWith("team-a");
  expect(service.offers).toHaveBeenCalledExactlyOnceWith("team-b", 3);
  expect(service.open).toHaveBeenCalledExactlyOnceWith("team-a", target);
  expect(service.leave).toHaveBeenCalledExactlyOnceWith("team-b");
});
it("does not turn an unavailable service into an empty inventory", () => {
  const handlers = createOrganizationBillingHandlers(null);
  expect(() => handlers["organization.billing.get"]({ spaceId: "team-a" })).toThrow("aren't available");
});
