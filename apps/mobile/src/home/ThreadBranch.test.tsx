import { expect, it, vi } from "vitest";
import { ThreadBranch } from "./ThreadBranch";
import { fixtureThreads } from "./test-fixtures/threads";

vi.mock("../ui/mode", () => ({ useColors: () => ({ line: "fixture-line" }) }));
const dimensions = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock("react-native", () => ({ StyleSheet: { absoluteFill: {}, hairlineWidth: 1 }, PixelRatio: { get: () => 3 }, View: "div", Pressable: "button", useWindowDimensions: () => dimensions }));
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));
vi.mock("react-native-reanimated", () => ({ default: { View: "div" } }));
vi.mock("../ui/motion", () => ({ arriveAt: () => ({}), leave: {}, turn: () => ({}) }));
vi.mock("../generated/icons", () => ({ ChevronDown: "svg" }));
vi.mock("../ui/reduced-motion", () => ({ useReducedMotion: () => true }));

it("mounts no SVG for a row without a branch", () => {
  const row = { thread: fixtureThreads[0]!, depth: 0, last: true, hasChildren: false, expanded: false, continuing: [] };
  expect(ThreadBranch({ row, height: 52, mid: 19 })).toBeNull();
  expect(ThreadBranch({ row: { ...row, hasChildren: true }, height: 52, mid: 19 })).toBeNull();
  expect(ThreadBranch({ row: { ...row, depth: 1 }, height: 44, mid: 22 })).not.toBeNull();
  expect(ThreadBranch({ row: { ...row, hasChildren: true, expanded: true }, height: 52, mid: 19 })).not.toBeNull();
});

it("paints the tree's line as one opaque color over the ground, so overlapping rows never darken it", async () => {
  const { solid } = await import("./ThreadBranch");
  const { colors } = await import("../generated/tokens");
  const gray = (color: string) => [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
  // The strong line is 18% ink: over the light tile it lands at 204 of 255, over the dark one at 65.
  expect(solid(colors.light["line-strong"], colors.light.bg)).toHaveLength(7);
  expect(gray(solid(colors.light["line-strong"], colors.light.bg))).toEqual([204, 204, 204]);
  expect(gray(solid(colors.dark["line-strong"], colors.dark.bg))).toEqual([65, 65, 65]);
  expect(solid("currentColor", colors.dark.bg)).toBe("currentColor");
});

it("keeps a disclosure's pressed circle inside its row, centered on the title line, with a 44 pt touch at every text size", async () => {
  const { TreeToggle } = await import("./ThreadBranch");
  const { titleMid } = await import("./grid");
  const tree = { thread: fixtureThreads[0]!, depth: 0, last: true, hasChildren: true, expanded: false, continuing: [] };
  for (const fontScale of [0.82, 1, 1.4, 2.4])
    for (const compact of [false, true]) {
      dimensions.fontScale = fontScale;
      const { style, hitSlop } = TreeToggle({ tree, open: false, compact, onFold: () => undefined })!.props as {
        style: { top: number; height: number };
        hitSlop: number;
      };
      expect(style.top, `${fontScale} ${compact}`).toBeGreaterThanOrEqual(0);
      expect(style.top + style.height / 2).toBeCloseTo(titleMid(compact, fontScale));
      expect(style.height + 2 * hitSlop).toBe(44);
    }
  dimensions.fontScale = 1;
});
