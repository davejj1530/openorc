import type { ThreadTreeRow } from "@openorc/client";
import { useState, type ReactNode } from "react";
import { PixelRatio, Pressable, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { ChevronDown } from "../generated/icons";
import { turn } from "../ui/motion";
import { useColors } from "../ui/mode";
import { useReducedMotion } from "../ui/reduced-motion";
import { movingStyle, type RowMotion } from "./fold-motion";
import { ACTION_RIGHT, MAX_DEPTH, STEP, TEXT_X, titleMid } from "./grid";
import { branchPath, pagePath, SEAM } from "./tree-lines";

/** How far a row of the tree steps in from a root's. */
export const treeIndent = (depth: number) => Math.min(depth, MAX_DEPTH) * STEP;

/** The tree's line: one point, the strong line's ink in both themes. */
const WEIGHT = 1;

/**
 * `line` (#rrggbbaa) laid over `ground` (#rrggbb) as one opaque color, so where a row's lines run into the next row's
 * they never darken; a color in another form passes through.
 */
export function solid(line: string, ground: string): string {
  const [ink, base] = [/^#([\da-f]{6})([\da-f]{2})$/i.exec(line), /^#([\da-f]{6})$/i.exec(ground)];
  if (!ink || !base) return line;
  const alpha = parseInt(ink[2]!, 16) / 255;
  const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
  const mixed = [0, 2, 4].map((at) => Math.round(channel(ink[1]!, at) * alpha + channel(base[1]!, at) * (1 - alpha)));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
/** Half a device pixel where a one point line covers an odd number of them, so it lands on whole pixels, crisp. */
const NUDGE = (PixelRatio.get() % 2) / (2 * PixelRatio.get());

/**
 * A row's share of its project's tree (see `branchPath`), or a paging row's, which only lets its ancestors' trunks
 * through. One stroke owns every segment, so coincident lanes at the indentation cap never darken.
 */
export function ThreadBranch({ row, height, mid, reach = null, paging = false }: { row: ThreadTreeRow; height: number; mid: number; reach?: number | null; paging?: boolean }) {
  const colors = useColors();
  // Trunks run past the row's top and foot so rows join without a seam; only the elbows' line moves by the nudge.
  const branch = paging ? pagePath(row, height) : branchPath(row, { mid: mid + NUDGE, height, reach });
  if (!branch) return null;
  return (
    <Svg pointerEvents="none" width={TEXT_X + treeIndent(row.depth)} height={height + 2 * SEAM} style={lines}>
      <Path d={branch} transform={`translate(${NUDGE} ${SEAM})`} fill="none" stroke={solid(colors["line-strong"], colors.bg)} strokeWidth={WEIGHT} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * A parent's disclosure, in the action column on its title line, where the headings' pluses and the header's circles
 * line up: the chevron points down while its sub threads are folded and turns up as they open. `open` already says
 * what the reader asked for while the rows still move.
 */
export function TreeToggle({ tree, open, compact, onFold }: { tree?: ThreadTreeRow; open: boolean; compact: boolean; onFold?: (id: string, open: boolean) => void }) {
  const still = useReducedMotion();
  const top = titleMid(compact, useWindowDimensions().fontScale) - 22;
  if (!tree?.hasChildren || !onFold) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${open ? "Collapse" : "Expand"} ${tree.thread.title}`}
      accessibilityState={{ expanded: open }}
      onPress={() => onFold(tree.thread.id, !open)}
      className="absolute size-touch items-center justify-center rounded-full active:bg-surface-2"
      style={{ right: ACTION_RIGHT, top }}
    >
      {/* Keyed so a row the list recycles for another thread does not turn from that thread's state. */}
      <Animated.View key={tree.thread.id} style={turn(open, still)}>
        <ChevronDown size={16} className="text-ink-4" />
      </Animated.View>
    </Pressable>
  );
}

/**
 * A row of a tree: it rises in as its fold opens, fades as it folds, and draws its branch over its lead. A root row's
 * own line leaves from its `node`, the project glyph on its last line, rather than its title line.
 */
export function ThreadTreeFrame({
  tree,
  reach,
  node,
  motion,
  compact,
  children,
}: {
  tree?: ThreadTreeRow;
  reach: number | null;
  node?: { mid: number; reach: number };
  motion: RowMotion;
  compact: boolean;
  children: ReactNode;
}) {
  const still = useReducedMotion();
  const fontScale = useWindowDimensions().fontScale;
  const [height, setHeight] = useState(compact ? 44 : 60);
  return (
    <Animated.View style={movingStyle(motion, still)} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      {children}
      {tree ? <ThreadBranch row={tree} height={height} mid={node?.mid ?? titleMid(compact, fontScale)} reach={node?.reach ?? reach} /> : null}
    </Animated.View>
  );
}

const lines = { position: "absolute", left: 0, top: -SEAM } as const;
