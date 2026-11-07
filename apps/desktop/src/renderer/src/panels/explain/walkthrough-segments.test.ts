import { expect, it } from "vitest";
import type { WalkthroughBlock } from "@openorc/protocol";
import { walkthroughSegments } from "./walkthrough-segments";

const block = (start: number, end: number): WalkthroughBlock => ({ lines: { start, end }, title: `Lines ${start}`, explanation: "", steps: [], symbols: [], usedBy: [] });
const lines = ["import a;", "", "const b = 1;", "", "", "function c() {}", "// tail", ""];

it("reads the file top to bottom, showing the code no block covers without its blank edges", () => {
  expect(walkthroughSegments([block(1, 1), block(6, 6)], lines)).toEqual([
    { kind: "block", block: block(1, 1) },
    { kind: "code", start: 3, end: 3 },
    { kind: "block", block: block(6, 6) },
    { kind: "code", start: 7, end: 7 },
  ]);
});

it("leaves out stretches that are only blank, and lines past the end of the file", () => {
  expect(walkthroughSegments([block(1, 3), block(4, 7)], [...lines, "", ""])).toEqual([
    { kind: "block", block: block(1, 3) },
    { kind: "block", block: block(4, 7) },
  ]);
  expect(walkthroughSegments([block(1, 7)], lines.slice(0, 3))).toEqual([{ kind: "block", block: block(1, 7) }]);
});
