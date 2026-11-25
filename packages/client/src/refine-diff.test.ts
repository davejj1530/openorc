import { describe, expect, it } from "vitest";
import { alignBlocks, similarity, wordDiff } from "./refine-diff";

describe("Refine's diff", () => {
  it("reads a replaced phrase as one replacement, keeping what didn't change", () => {
    expect(wordDiff("The filter survives an app restart.", "The filter survives quitting and reopening OpenOrc.")).toEqual([
      { kind: "same", text: "The filter survives " },
      { kind: "del", text: "an app restart" },
      { kind: "ins", text: "quitting and reopening OpenOrc" },
      { kind: "same", text: "." },
    ]);
    expect(wordDiff("Same text", "Same text")).toEqual([{ kind: "same", text: "Same text" }]);
    expect(wordDiff("", "All new")).toEqual([{ kind: "ins", text: "All new" }]);
  });

  it("pairs a reworded block as changed, and the rest as added or removed, removed first", () => {
    const block = (text: string) => ({ key: `p:${text}`, text });
    const ops = alignBlocks(
      [block("Goal"), block("The filter survives an app restart."), block("typing labels is annoying")],
      [block("Goal"), block("The filter survives quitting and reopening OpenOrc."), block("Verification"), block("By hand: quit and reopen.")],
    );
    expect(ops.map((op) => op.kind)).toEqual(["same", "removed", "changed", "added", "added"]);
    expect(ops[1]).toEqual({ kind: "removed", base: 2 });
  });

  it("replaces the whole text past its comparison limit, which is coarser but still correct", () => {
    const before = "word ".repeat(300);
    const after = `${before}more`;
    expect(wordDiff(before, after)).toEqual([
      { kind: "del", text: before },
      { kind: "ins", text: after },
    ]);
    expect(wordDiff("word ".repeat(200), "word ".repeat(200) + "more")).toEqual([
      { kind: "same", text: "word ".repeat(200) },
      { kind: "ins", text: "more" },
    ]);
  });

  it("measures shared words", () => {
    expect(similarity("a b c d", "a b c d")).toBe(1);
    expect(similarity("one two", "three four")).toBe(0);
  });
});
