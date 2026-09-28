import { describe, expect, it, vi } from "vitest";
import { captureWithRetry } from "./team-capture-retry.js";

describe("capture retry", () => {
  it("retries only the capture race, a bounded number of times, and checks admission between tries", async () => {
    const race = () => new Error("The source changed while its team snapshot was captured. Retry under the workspace writer lease.");
    const assertActive = vi.fn();
    const flaky = vi.fn().mockRejectedValueOnce(race()).mockRejectedValueOnce(race()).mockResolvedValue("tree");
    expect(await captureWithRetry(flaky, { delayMs: 1, assertActive })).toBe("tree");
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(assertActive).toHaveBeenCalledTimes(2);
    const stuck = vi.fn().mockRejectedValue(race());
    await expect(captureWithRetry(stuck, { delayMs: 1 })).rejects.toThrow(/changed while its team snapshot/);
    expect(stuck).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockRejectedValue(new Error('Nested repositories cannot be transferred: "vendor".'));
    await expect(captureWithRetry(other, { delayMs: 1 })).rejects.toThrow(/Nested repositories/);
    expect(other).toHaveBeenCalledTimes(1);
    const fenced = vi.fn().mockRejectedValueOnce(race()).mockResolvedValue("tree");
    await expect(
      captureWithRetry(fenced, {
        delayMs: 1,
        assertActive: () => {
          throw new Error("This assignment is no longer admitted.");
        },
      }),
    ).rejects.toThrow(/no longer admitted/);
  });
});
