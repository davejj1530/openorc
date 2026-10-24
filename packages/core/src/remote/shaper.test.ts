import { OMIT_OUTPUT_CHARS } from "@openorc/db";
import type { AgentEvent } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { RemoteFrameShaper } from "./shaper.js";

const output = (text: string, toolCallId = "call"): AgentEvent => ({ type: "tool.output.delta", runId: "run", ts: 1, toolCallId, text });
let seq = 0;
const streamedText = (shaper: RemoteFrameShaper, ...events: AgentEvent[]) =>
  shaper
    .shape({ runId: "run", seq: ++seq, events })
    .frame.events.flatMap((event) => (event.type === "tool.output.delta" ? [event.text] : []))
    .join("");

describe("live tool output to a phone", () => {
  it("stops at the page limit even inside one delta", () => {
    const shaper = new RemoteFrameShaper();
    expect(streamedText(shaper, output("a".repeat(100)))).toHaveLength(100);
    const crossing = streamedText(shaper, output("b".repeat(1_000_000)));
    expect(crossing).toBe("b".repeat(OMIT_OUTPUT_CHARS - 100));
    expect(streamedText(shaper, output("c"))).toBe("");
  });

  it.each<[string, AgentEvent]>([
    ["completes", { type: "session.completed", runId: "run", ts: 2, status: "success", durationMs: 1 }],
    ["fails", { type: "error", runId: "run", ts: 2, message: "the agent exited", fatal: true }],
  ])("forgets what a run streamed once the run %s", (_end, end) => {
    const shaper = new RemoteFrameShaper();
    streamedText(shaper, output("x".repeat(OMIT_OUTPUT_CHARS)));
    expect(streamedText(shaper, output("dropped"))).toBe("");
    streamedText(shaper, end);
    expect(streamedText(shaper, output("again"))).toBe("again");
  });

  it("keeps counting across a non-fatal error", () => {
    const shaper = new RemoteFrameShaper();
    streamedText(shaper, output("x".repeat(OMIT_OUTPUT_CHARS)));
    streamedText(shaper, { type: "error", runId: "run", ts: 2, message: "stderr line", fatal: false });
    expect(streamedText(shaper, output("dropped"))).toBe("");
  });
});
