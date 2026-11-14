import { describe, expect, it } from "vitest";
import { organizationBillingRpcParams } from "./organization-billing.js";
import { accountRpcParams } from "./account.js";

describe("organization billing input", () => {
  it.each([0, -1, 101, 1.5, Number.NaN])("refuses quantity %s before requesting offers or checkout", (seats) => {
    expect(organizationBillingRpcParams["organization.billing.offers"].safeParse({ spaceId: "team-a", seats }).success).toBe(false);
    expect(organizationBillingRpcParams["organization.billing.open"].safeParse({ spaceId: "team-a", target: { page: "checkout", plan: "monthly", seats } }).success).toBe(false);
  });
  it.each([1, 100])("accepts boundary quantity %s with an explicit organization", (seats) => {
    expect(organizationBillingRpcParams["organization.billing.open"].parse({ spaceId: "team-a", target: { page: "checkout", plan: "yearly", seats } })).toMatchObject({
      spaceId: "team-a",
      target: { seats },
    });
  });
  it("keeps organization pages out of personal billing and refuses missing scope or unexpected fields", () => {
    expect(accountRpcParams["account.billing.open"].safeParse({ page: "checkout", plan: "monthly", seats: 1 }).success).toBe(false);
    expect(organizationBillingRpcParams["organization.billing.get"].safeParse({}).success).toBe(false);
    expect(organizationBillingRpcParams["organization.billing.open"].safeParse({ spaceId: "team-a", target: { page: "billing", token: "not-accepted" } }).success).toBe(false);
  });
});
