import { describe, expect, it } from "vitest";
import { conversationCost, formatCost } from "./conversation-cost.js";

const run = (id: string, session: string | null, costUsd?: number) => ({
  id,
  externalSessionId: session,
  usage: costUsd === undefined ? null : { inputTokens: 0, outputTokens: 0, costUsd },
});

describe("conversationCost", () => {
  it("takes a resumed session's latest total once", () => {
    expect(conversationCost([run("a", "s1", 0.4), run("b", "s1", 1.25), run("c", "s1", 1.97)])).toBe(1.97);
  });

  it("adds up the sessions a conversation went through, as after a fork or a fresh start", () => {
    expect(conversationCost([run("a", "parent", 2), run("b", "fork", 0.5), run("c", "fork", 0.75)])).toBe(2.75);
  });

  it("skips runs that reported nothing and is null when none did", () => {
    expect(conversationCost([run("a", "s1", 1), run("b", "s1")])).toBe(1);
    expect(conversationCost([run("a", "s1"), run("b", null)])).toBeNull();
    expect(conversationCost([])).toBeNull();
  });

  it("counts a free model's zero as a report", () => {
    expect(conversationCost([run("a", "s1", 0)])).toBe(0);
  });
});

describe("formatCost", () => {
  it("writes dollars and cents, and says when an amount is under a cent", () => {
    expect(formatCost(1.9698)).toBe("$1.97");
    expect(formatCost(1204.5)).toBe("$1,204.50");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.003)).toBe("under $0.01");
  });
});
