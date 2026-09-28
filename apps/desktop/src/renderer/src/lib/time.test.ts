import { describe, expect, it } from "vitest";
import { formatTokens } from "./time";

describe("formatTokens", () => {
  it("rounds to thousands below a million", () => {
    expect(formatTokens(30_074)).toBe("30k");
    expect(formatTokens(164_400)).toBe("164k");
    expect(formatTokens(200_000)).toBe("200k");
  });

  it("switches to millions at the 1M window", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_029_677)).toBe("1M");
    expect(formatTokens(2_052_239)).toBe("2.1M");
  });
});
