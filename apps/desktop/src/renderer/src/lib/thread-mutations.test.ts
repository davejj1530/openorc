import { describe, expect, it } from "vitest";
import { threadMutationBlocks } from "./thread-mutations";

describe("threadMutationBlocks", () => {
  it("counts team-changing mutations on the thread and ignores other threads", () => {
    expect(threadMutationBlocks("t1", { id: "t1", checkpointId: "c" })).toBe(true);
    expect(threadMutationBlocks("t1", { threadId: "t1", text: "hi" })).toBe(true);
    expect(threadMutationBlocks("t1", { id: "t2", patch: { title: "x" } })).toBe(false);
    expect(threadMutationBlocks("t1", null)).toBe(false);
  });
  it("lets marking a thread seen or saving a draft pass without disabling its controls", () => {
    expect(threadMutationBlocks("t1", { id: "t1", patch: { seen: true } })).toBe(false);
    expect(threadMutationBlocks("t1", { id: "t1", patch: { draft: "typing" } })).toBe(false);
    expect(threadMutationBlocks("t1", { id: "t1", patch: { draft: null, seen: true } })).toBe(false);
    expect(threadMutationBlocks("t1", { id: "t1", patch: { title: "renamed" } })).toBe(true);
  });
});
