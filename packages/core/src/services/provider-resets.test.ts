import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "@openorc/db";
import type { CodexAccountReport, consumeCodexReset } from "@openorc/agents";
import { CodexResetService } from "./provider-resets.js";

const at = 1_800_000_000_000;
const report = (count = 2, email = "fixture@example.test"): CodexAccountReport => ({
  account: { type: "chatgpt", email, planType: "pro" },
  limits: { rateLimitResetCredits: { availableCount: count, credits: [{ id: "fixture-credit", status: "available", expiresAt: at / 1000 + 100, title: "Full reset", description: "Fixture reset" }] } },
});
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = Db.memory();
  databases.push(db);
  let current = report();
  const consume = vi.fn<typeof consumeCodexReset>(async (_input, _options, authorize) => {
    authorize(current);
    return "reset";
  });
  const service = new CodexResetService(db, consume, () => at);
  const input = { attemptId: "attempt-1", creditId: "fixture-credit", confirmationToken: service.describe(current, "fixture").confirmationToken! };
  return {
    db,
    service,
    consume,
    input,
    setReport: (value: CodexAccountReport) => {
      current = value;
    },
  };
}

describe("reset attempts (all provider responses are fixtures)", () => {
  it("coalesces duplicates and records terminal outcomes without redeeming again", async () => {
    const { service, consume, input } = setup();
    const first = service.redeem(input, {}, "fixture");
    expect(service.redeem(input, {}, "fixture")).toBe(first);
    expect((await first).outcome).toBe("reset");
    let actualConsumes = 0;
    consume.mockImplementation(async (_input, _options, authorize) => {
      authorize(report());
      actualConsumes++;
      return "reset";
    });
    expect((await service.redeem(input, {}, "fixture")).outcome).toBe("reset");
    expect(actualConsumes).toBe(0);
  });
  it("keeps a lost response across restart, refuses a second attempt and retries its original key", async () => {
    const { db, service, consume, input } = setup();
    consume.mockImplementationOnce(async (_input, _options, authorize) => {
      authorize(report());
      throw new Error("lost response containing private token");
    });
    expect(await service.redeem(input, {}, "fixture")).toMatchObject({ outcome: "pending", message: expect.not.stringContaining("private token") });
    const restarted = new CodexResetService(db, consume, () => at);
    expect(restarted.describe(report(), "fixture").pendingAttempt?.id).toBe(input.attemptId);
    expect((await restarted.redeem({ ...input, attemptId: "another" }, {}, "fixture")).outcome).toBe("pending");
    consume.mockImplementationOnce(async (request, _options, authorize) => {
      expect(request.idempotencyKey).toBe(input.attemptId);
      authorize(report(0)); // Inventory changed because the lost response was a success.
      return "alreadyRedeemed";
    });
    expect((await restarted.redeem(input, {}, "fixture")).outcome).toBe("alreadyRedeemed");
    expect(restarted.describe(report(), "fixture").pendingAttempt).toBeUndefined();
  });
  it("requires new confirmation for changed accounts, changed inventory, unknown or expired credit IDs", async () => {
    const { db, service, consume, input } = setup();
    let actualConsumes = 0;
    let current = report(3);
    consume.mockImplementation(async (_input, _options, authorize) => {
      authorize(current);
      actualConsumes++;
      return "reset";
    });
    expect((await service.redeem(input, {}, "fixture")).outcome).toBe("confirmationRequired");
    current = report(2, "other@example.test");
    expect((await service.redeem(input, {}, "fixture")).outcome).toBe("confirmationRequired");
    current = report();
    expect((await service.redeem({ ...input, creditId: "unknown" }, {}, "fixture")).outcome).toBe("confirmationRequired");
    const expired = new CodexResetService(db, consume, () => at + 100_000);
    expect((await expired.redeem(input, {}, "fixture")).outcome).toBe("confirmationRequired");
    expect(actualConsumes).toBe(0);
    expect(expired.describe(current, "fixture").credits).toEqual([]);
  });
  it.each(["unsupported"] as const)("reports %s separately", async (outcome) => {
    const { service, consume, input } = setup();
    consume.mockImplementationOnce(async (_input, _options, authorize) => {
      authorize(report());
      return outcome;
    });
    expect((await service.redeem(input, {}, "fixture")).outcome).toBe(outcome);
    expect(service.describe(report(), "fixture").pendingAttempt).toBeUndefined();
    if (outcome === "unsupported") expect(service.describe(report(), "fixture").redemption).toBe("external");
  });
});
