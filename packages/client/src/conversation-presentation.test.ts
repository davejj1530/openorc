import { describe, expect, it } from "vitest";
import { acceptsLiveInput, conversationActivity, conversationCanSteer, conversationPlaceholder, conversationSteerReason } from "./conversation-presentation.js";
import { emptyRun, type Block } from "./transcript.js";

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

it("puts first task direction before active-turn placeholder states", () => {
  expect(conversationPlaceholder({ firstTaskRun: true, working: true, canSteer: true, agent: undefined })).toBe("Add direction, or send to start this task…");
  expect(conversationPlaceholder({ firstTaskRun: false, working: true, canSteer: false, agent: undefined })).toBe("Queue a message for when it finishes…");
  expect(conversationPlaceholder({ firstTaskRun: false, working: false, canSteer: false, agent: "claude" })).toBe("Message Claude…");
});

describe("conversationActivity", () => {
  const run = { id: "r", agent: "codex", model: null } as unknown as Parameters<typeof conversationActivity>[0]["activeRun"];
  const live = (blocks: Block[]) => ({ ...emptyRun("r"), live: true, blocks });
  const replying: Block = { id: "m", kind: "message", role: "assistant", text: "Hi", streaming: true };
  const making: Block = { id: "img", kind: "activity", label: "Image", status: "running", text: "", activityKind: "image_generation" };

  it("takes a thread's own word for whether it is busy", () => {
    expect(conversationActivity({ thread: { activity: "running" }, activeRun: run, liveTranscript: live([]), compacting: false })).toEqual({ live: true, working: true, generatingImage: false });
    expect(conversationActivity({ thread: { activity: "idle" }, activeRun: run, liveTranscript: live([replying]), compacting: false }).working).toBe(false);
  });

  it("counts an image being made and a compaction as busy, and a task's conversation while its reply streams", () => {
    expect(conversationActivity({ thread: { activity: "idle" }, activeRun: run, liveTranscript: live([making]), compacting: false })).toMatchObject({ working: true, generatingImage: true });
    expect(conversationActivity({ thread: { activity: "idle" }, activeRun: run, liveTranscript: live([]), compacting: true }).working).toBe(true);
    expect(conversationActivity({ thread: null, activeRun: run, liveTranscript: live([replying]), compacting: false }).working).toBe(true);
    expect(conversationActivity({ thread: null, activeRun: undefined, liveTranscript: live([replying]), compacting: false })).toMatchObject({ live: false, working: false });
  });
});
