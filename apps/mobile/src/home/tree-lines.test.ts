import type { ThreadTreeRow } from "@openorc/client";
import { expect, it } from "vitest";
import { LEAD_CENTER, ROOT_NODE, STEP, TEXT_X } from "./grid";
import { branchPath, LINE_GAP, pagePath, SEAM } from "./tree-lines";
import { fixtureThreads } from "./test-fixtures/threads";

const row = (facts: Partial<ThreadTreeRow>): ThreadTreeRow => ({ thread: fixtureThreads[0]!, depth: 0, hasChildren: false, expanded: false, last: true, continuing: [], ...facts });
const ring = 6.25;
const child = LEAD_CENTER + STEP;

it("leaves a root's project glyph and ends every elbow the same gap short of what it meets: a glyph's edge, or the title", () => {
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: ring })).toBe(`M${ROOT_NODE} ${-SEAM}V16q0 6 6 6H${child - ring - LINE_GAP}`);
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: 4 })).toBe(`M${ROOT_NODE} ${-SEAM}V16q0 6 6 6H${child - 4 - LINE_GAP}`);
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: null })).toBe(`M${ROOT_NODE} ${-SEAM}V16q0 6 6 6H${TEXT_X + STEP - LINE_GAP}`);
  expect(branchPath(row({ depth: 2 }), { mid: 22, height: 44, reach: ring })).toBe(`M${child} ${-SEAM}V16q0 6 6 6H${LEAD_CENTER + 2 * STEP - ring - LINE_GAP}`);
});

it("carries the parent's trunk past a child that has siblings after it and stops it at the last child's elbow", () => {
  expect(branchPath(row({ depth: 1, last: false }), { mid: 22, height: 44, reach: ring })).toContain(`M${ROOT_NODE} 16V${44 + SEAM}`);
  expect(branchPath(row({ depth: 1, last: true }), { mid: 22, height: 44, reach: ring })).not.toContain(`V${44 + SEAM}`);
});

it("drops a parent's trunk the same gap under its glyph, or turns it down out of the space before its title", () => {
  const open = { hasChildren: true, expanded: true, visibleChildren: 2 };
  // A root's glyph is its project's, on its last line.
  expect(branchPath(row(open), { mid: 43, height: 60, reach: 6 })).toBe(`M${ROOT_NODE} ${43 + 6 + LINE_GAP}V${60 + SEAM}`);
  expect(branchPath(row({ ...open, depth: 1 }), { mid: 22, height: 60, reach: ring })).toContain(`M${child} ${22 + ring + LINE_GAP}V${60 + SEAM}`);
  expect(branchPath(row({ ...open, depth: 1 }), { mid: 22, height: 60, reach: null })).toContain(`M${TEXT_X + STEP - LINE_GAP} 22H${child + 6}q-6 0 -6 6V${60 + SEAM}`);
  expect(branchPath(row({ ...open, expanded: false }), { mid: 19, height: 60, reach: ring })).toBe("");
  expect(branchPath(row({ ...open, visibleChildren: 0 }), { mid: 19, height: 60, reach: ring })).toBe("");
});

it("runs every trunk a seam past its row's top and foot, so stacked rows draw one unbroken line", () => {
  expect(branchPath(row({ depth: 2, continuing: [1] }), { mid: 22, height: 44, reach: ring })).toMatch(new RegExp(`^M${ROOT_NODE} ${-SEAM}V${44 + SEAM}`));
  expect(pagePath(row({ depth: 1, last: false }), 44)).toBe(`M${ROOT_NODE} ${-SEAM}V${44 + SEAM}`);
  expect(pagePath(row({ depth: 1, last: true }), 44)).toBe("");
});
