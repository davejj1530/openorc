import { afterEach, expect, it, vi } from "vitest";
import { core } from "./rpc";
import { organizationBillingTransport } from "./organization-billing-rpc";

vi.mock("./rpc", () => ({ core: { call: vi.fn(), onPush: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

it("explains an older core without requesting a legacy purchase", async () => {
  vi.mocked(core.call).mockRejectedValueOnce(new Error("unknown method organization.billing.get"));
  await expect(organizationBillingTransport.get("team-a")).rejects.toThrow("Update OpenOrc to manage organization seats.");
  expect(core.call).toHaveBeenCalledExactlyOnceWith("organization.billing.get", { spaceId: "team-a" });
});

it("retains the server's refusal and the requested organization", async () => {
  const refusal = new Error("Only an admin can do that.");
  vi.mocked(core.call).mockRejectedValueOnce(refusal);
  await expect(organizationBillingTransport.open("team-b", { page: "checkout", plan: "yearly", seats: 3 })).rejects.toBe(refusal);
  expect(core.call).toHaveBeenCalledExactlyOnceWith("organization.billing.open", { spaceId: "team-b", target: { page: "checkout", plan: "yearly", seats: 3 } });
});
