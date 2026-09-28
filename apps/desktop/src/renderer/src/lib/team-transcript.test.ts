import { describe, expect, it } from "vitest";
import type { TeamChatEntry } from "@openorc/protocol";
import type { Block } from "./transcript";
import { teamChatText, teamTranscriptParts } from "./team-transcript";

const message = (id: string, text: string): Block => ({ kind: "message", id, text, role: "assistant", streaming: false });
const work: Block[] = [
  message("commentary", "Checking the files"),
  { kind: "thinking", id: "think", text: "Look at tests", startedAt: 1, endedAt: 2 },
  { kind: "tool", id: "tool", name: "exec", input: {}, done: true },
];
const entry = (text: string): TeamChatEntry => ({
  id: "chat",
  senderId: "member:sol",
  senderName: "Sol",
  text,
  attachments: [],
  createdAt: 1,
  to: [
    { actorId: "lead", name: "Lead", state: "delivered" },
    { actorId: "member:sol2", name: "Sol 2", state: "pending" },
  ],
});

describe("team conversation presentation", () => {
  it("folds commentary and interleaved reasoning/tools, leaving the final reply visible", () => {
    const reply = message("reply", "All checks passed.");
    expect(teamTranscriptParts([...work, reply], false)).toEqual({ work, visible: [reply] });
    expect(teamTranscriptParts(work, true)).toEqual({ work, visible: [] });
  });
  it("never folds pending questions, refusals, or turn errors", () => {
    const attention: Block[] = [
      { kind: "approval", id: "ask", approvalId: "ask", approvalKind: "user_input", input: {} },
      { kind: "approval", id: "deny", approvalId: "deny", approvalKind: "command", input: {}, decision: "deny" },
      { kind: "status", id: "error", tone: "bad", text: "Provider disconnected" },
    ];
    expect(teamTranscriptParts([...work, ...attention], true)).toEqual({ work, visible: attention });
  });
  it("suppresses uneventful ambient reads but retains actual work", () => {
    expect(teamTranscriptParts([work[1]!, message("silent", "Nothing to add")], false, true)).toEqual({ work: [], visible: [] });
    expect(teamTranscriptParts(work, false, true)).toEqual({ work, visible: [] });
  });
  it("adds only missing inline mentions and preserves multiword names and aliases", () => {
    expect(teamChatText(entry("Ready."))).toBe("@Lead @Sol 2 Ready.");
    expect(teamChatText(entry("@lead @Sol 2, ready."))).toBe("@lead @Sol 2, ready.");
    expect(teamChatText(entry("@everyone ready."))).toBe("@everyone ready.");
    expect(teamChatText(entry("@Leadership ready."))).toBe("@Lead @Sol 2 @Leadership ready.");
  });
});
