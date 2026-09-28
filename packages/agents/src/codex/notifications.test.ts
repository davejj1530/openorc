import { describe, expect, it } from "vitest";
import { mapNotification, type NotificationState } from "./notifications.js";

function state(): NotificationState {
  return { summaryIndex: new Map(), buffering: new Set() };
}

describe("Codex notification input", () => {
  it("reports malformed records once and maps the next valid notification", () => {
    const mapperState = state();
    const malformed: Array<[string, unknown]> = [
      ["turn/plan/updated", null],
      ["turn/plan/updated", { plan: null }],
      ["turn/plan/updated", { plan: [null] }],
      ["item/started", { item: null }],
      ["item/completed", { item: { id: "file", type: "fileChange", changes: null } }],
      ["item/completed", { item: { id: "file", type: "fileChange", changes: [null] } }],
    ];

    for (const [method, params] of malformed) {
      expect(mapNotification("malformed", method, params, mapperState)).toEqual([expect.objectContaining({ type: "error", runId: "malformed", fatal: false })]);
    }

    expect(mapNotification("malformed", "item/agentMessage/delta", { itemId: "next", delta: "Still here" }, mapperState)).toEqual([
      expect.objectContaining({ type: "message.delta", messageId: "next", text: "Still here" }),
    ]);
    expect(mapNotification("malformed", "future/event", { nested: { value: true } }, mapperState)).toEqual([]);
    expect(mapNotification("malformed", "future/event", ["positional", { value: true }], mapperState)).toEqual([]);
  });

  it("does not settle a turn or clear reasoning state for a malformed completion", () => {
    const mapperState = state();
    mapperState.summaryIndex.set("reasoning", 2);
    mapperState.buffering.add("buffering-turn");

    expect(mapNotification("malformed", "turn/completed", { turn: null }, mapperState)).toEqual([expect.objectContaining({ type: "error", fatal: false })]);
    expect(mapperState.summaryIndex.get("reasoning")).toBe(2);
    expect(mapperState.buffering.has("buffering-turn")).toBe(true);

    expect(mapNotification("malformed", "turn/completed", { turn: { id: "turn", status: "completed" } }, mapperState)).toContainEqual(
      expect.objectContaining({ type: "turn.completed", turnId: "turn", status: "success" }),
    );
    expect(mapperState.summaryIndex.size).toBe(0);
    expect(mapperState.buffering.size).toBe(0);
  });

  it("retains reasoning paragraph state across a malformed item before its valid completion", () => {
    const mapperState = state();
    const events = [
      ...mapNotification("reasoning", "item/started", { item: { id: "thought", type: "reasoning" } }, mapperState),
      ...mapNotification("reasoning", "item/reasoning/summaryTextDelta", { itemId: "thought", summaryIndex: 0, delta: "First" }, mapperState),
      ...mapNotification("reasoning", "item/completed", { item: null }, mapperState),
      ...mapNotification("reasoning", "item/reasoning/summaryTextDelta", { itemId: "thought", summaryIndex: 1, delta: "Second" }, mapperState),
      ...mapNotification("reasoning", "item/completed", { item: { id: "thought", type: "reasoning", summary: ["First", "Second"] } }, mapperState),
    ];

    expect(events.map((event) => event.type)).toEqual(["thinking.started", "thinking.delta", "error", "thinking.delta", "thinking.completed"]);
    expect(events[3]).toMatchObject({ messageId: "thought", text: "\n\nSecond" });
    expect(events[4]).toMatchObject({ messageId: "thought", text: "First\n\nSecond" });
    expect(mapperState.summaryIndex.has("thought")).toBe(false);
  });
});
