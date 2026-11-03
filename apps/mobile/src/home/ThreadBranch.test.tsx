import { expect, it, vi } from "vitest";
import { ThreadBranch } from "./ThreadBranch";
import { fixtureThreads } from "./test-fixtures/threads";

vi.mock("../ui/mode", () => ({ useColors: () => ({ line: "fixture-line" }) }));
vi.mock("react-native", () => ({ StyleSheet: { absoluteFill: {}, hairlineWidth: 1 }, View: "div", Pressable: "button" }));
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));
vi.mock("react-native-reanimated", () => ({ default: { View: "div" } }));
vi.mock("../ui/motion", () => ({ arrive: {} }));
vi.mock("../generated/icons", () => ({ ChevronRight: "svg" }));
vi.mock("../ui/reduced-motion", () => ({ useReducedMotion: () => true }));

it("mounts no SVG for a row without a branch", () => {
  const row = { thread: fixtureThreads[0]!, depth: 0, last: true, hasChildren: false, expanded: false, continuing: [] };
  expect(ThreadBranch({ row, height: 52 })).toBeNull();
  expect(ThreadBranch({ row: { ...row, hasChildren: true }, height: 52 })).toBeNull();
  expect(ThreadBranch({ row: { ...row, depth: 1 }, height: 44 })).not.toBeNull();
  expect(ThreadBranch({ row: { ...row, hasChildren: true, expanded: true }, height: 52 })).not.toBeNull();
});
