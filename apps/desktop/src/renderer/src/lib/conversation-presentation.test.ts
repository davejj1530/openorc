import { describe, expect, it } from "vitest";
import { acceptsLiveInput, conversationCanSteer, conversationSteerReason } from "./conversation-presentation";

describe("sending during a turn", () => {
  it("queues for a harness that cannot take input mid-turn and says why", () => {
    expect(acceptsLiveInput("opencode")).toBe(false);
    expect(conversationCanSteer({ live: true, sameAgent: true, agent: "opencode", compacting: false, settingsPending: false })).toBe(false);
    expect(conversationSteerReason({ canSteer: false, compacting: false, settingsPending: false, sameAgent: true, agent: "opencode" })).toBe(
      "This agent reads new messages after its turn. It will be queued.",
    );
  });

  it("sends live to Codex and Claude", () => {
    expect([acceptsLiveInput("codex"), acceptsLiveInput("claude"), acceptsLiveInput(undefined)]).toEqual([true, true, false]);
    expect(conversationCanSteer({ live: true, sameAgent: true, agent: "claude", compacting: false, settingsPending: false })).toBe(true);
    expect(conversationSteerReason({ canSteer: true, compacting: false, settingsPending: false, sameAgent: true, agent: "claude" })).toBeNull();
  });
});
