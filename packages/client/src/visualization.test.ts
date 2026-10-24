import { expect, it } from "vitest";
import type { Block } from "./transcript.js";
import { visualizationFromTool } from "./visualization.js";
import { workParts } from "./work-transcript.js";
import { foldable } from "./work-steps.js";

const input = { title: "A queue", description: "First in, first out.", html: "<p>1 → 2 → 3</p>" };
const tool: Extract<Block, { kind: "tool" }> = { id: "viz", kind: "tool", name: "openorc.visualize", input, done: true };

it.each(["openorc.visualize", `openorc_${"a".repeat(32)}.visualize`, `mcp__openorc_${"b".repeat(32)}__visualize`, `openorc_${"c".repeat(32)}_visualize`])(
  "shows saved %s input without loading omitted tool output or a live provider",
  (name) => {
    const saved = { ...tool, name, outputOmitted: true };
    expect(visualizationFromTool(saved)).toEqual(input);
    expect(workParts([saved], false).after).toEqual([saved]);
    expect(foldable(saved, true)).toBe(false);
  },
);

it.each([
  { name: "another.visualize" },
  { name: "mcp__untrusted__visualize" },
  { done: false },
  { isError: true },
  { status: "cancelled" },
  { status: "error" },
  { input: { ...input, html: "" } },
  { input: { title: "Missing source" } },
] satisfies Partial<typeof tool>[])("keeps invalid or unsuccessful calls in ordinary tool details: %j", (patch) => {
  const block = { ...tool, ...patch };
  expect(visualizationFromTool(block)).toBeNull();
  expect(workParts([block], false).after).toEqual([]);
});
