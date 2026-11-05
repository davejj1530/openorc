import type { ThreadTreeRow } from "@openorc/client";
import { expect, it } from "vitest";
import { LEAD_CENTER, STEP, TEXT_X } from "./grid";
import { branchPath, LINE_GAP, pagePath, SEAM } from "./tree-lines";
import { fixtureThreads } from "./test-fixtures/threads";

const row = (facts: Partial<ThreadTreeRow>): ThreadTreeRow => ({ thread: fixtureThreads[0]!, depth: 0, hasChildren: false, expanded: false, last: true, continuing: [], ...facts });
const ring = 6.25;
const child = LEAD_CENTER + STEP;

it("ends every elbow the same gap short of what it meets: a glyph's edge, or the title when the row shows no status", () => {
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: ring })).toBe(`M${LEAD_CENTER} ${-SEAM}V16q0 6 6 6H${child - ring - LINE_GAP}`);
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: 4 })).toBe(`M${LEAD_CENTER} ${-SEAM}V16q0 6 6 6H${child - 4 - LINE_GAP}`);
  expect(branchPath(row({ depth: 1 }), { mid: 22, height: 44, reach: null })).toBe(`M${LEAD_CENTER} ${-SEAM}V16q0 6 6 6H${TEXT_X + STEP - LINE_GAP}`);
});

it("carries the parent's trunk past a child that has siblings after it and stops it at the last child's elbow", () => {
  expect(branchPath(row({ depth: 1, last: false }), { mid: 22, height: 44, reach: ring })).toContain(`M${LEAD_CENTER} 16V${44 + SEAM}`);
  expect(branchPath(row({ depth: 1, last: true }), { mid: 22, height: 44, reach: ring })).not.toContain(`V${44 + SEAM}`);
});

it("drops a parent's trunk the same gap under its glyph, or turns it down out of the space before its title", () => {
  const open = { hasChildren: true, expanded: true, visibleChildren: 2 };
  expect(branchPath(row(open), { mid: 19, height: 60, reach: ring })).toBe(`M${LEAD_CENTER} ${19 + ring + LINE_GAP}V${60 + SEAM}`);
  expect(branchPath(row(open), { mid: 19, height: 60, reach: null })).toBe(`M${TEXT_X - LINE_GAP} 19H${LEAD_CENTER + 6}q-6 0 -6 6V${60 + SEAM}`);
  expect(branchPath(row({ ...open, expanded: false }), { mid: 19, height: 60, reach: ring })).toBe("");
  expect(branchPath(row({ ...open, visibleChildren: 0 }), { mid: 19, height: 60, reach: ring })).toBe("");
});

it("runs every trunk a seam past its row's top and foot, so stacked rows draw one unbroken line", () => {
  expect(branchPath(row({ depth: 2, continuing: [1] }), { mid: 22, height: 44, reach: ring })).toMatch(new RegExp(`^M${LEAD_CENTER} ${-SEAM}V${44 + SEAM}`));
  expect(pagePath(row({ depth: 1, last: false }), 44)).toBe(`M${LEAD_CENTER} ${-SEAM}V${44 + SEAM}`);
  expect(pagePath(row({ depth: 1, last: true }), 44)).toBe("");
});
