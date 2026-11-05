import { useState, type ReactNode } from "react";
import Animated from "react-native-reanimated";
import { ChevronRight } from "../generated/icons";
import { arrive } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { threadBranchPath, threadPageBranchPath, type ThreadTreeRow } from "@openorc/client";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useColors } from "../ui/mode";

export const TREE_STEP = 20;
const MARK_X = 52;

/** One stroke owns the elbows and continuations, including coincident lanes at the indentation cap. */
export function ThreadBranch({ row, height, paging = false }: { row: ThreadTreeRow; height: number; paging?: boolean }) {
  const colors = useColors();
  const depth = Math.min(row.depth, 3);
  const mid = height / 2 - (row.depth ? 0 : 9);
  const mark = MARK_X + depth * TREE_STEP;
  const branch = (paging ? threadPageBranchPath : threadBranchPath)(row, { markX: MARK_X, mid, height });
  if (!branch) return null;
  return (
    <Svg pointerEvents="none" width={mark} height={height} style={StyleSheet.absoluteFill}>
      <Path d={branch} fill="none" stroke={colors.line} strokeWidth={StyleSheet.hairlineWidth} />
    </Svg>
  );
}

export function ThreadTreeFrame({ tree, arriving, onToggle, children }: { tree?: ThreadTreeRow; arriving: boolean; onToggle?: () => void; children: ReactNode }) {
  const still = useReducedMotion();
  const [height, setHeight] = useState(tree?.depth ? 44 : 52);
  return (
    <Animated.View style={arriving && !still ? arrive : undefined} onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
      <View className="flex-row items-center" style={{ marginLeft: Math.min(tree?.depth ?? 0, 3) * TREE_STEP }}>
        {tree?.hasChildren ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${tree.expanded ? "Collapse" : "Expand"} ${tree.thread.title}`}
            accessibilityState={{ expanded: tree.expanded }}
            onPress={onToggle}
            hitSlop={8}
            className="w-6 min-h-touch items-center justify-center"
          >
            <View style={{ transform: [{ rotate: tree.expanded ? "90deg" : "0deg" }] }}>
              <ChevronRight size={12} className="text-ink-4" />
            </View>
          </Pressable>
        ) : null}
        {tree && !tree.hasChildren ? <View className="w-6" /> : null}
        <View className="min-w-0 flex-1">{children}</View>
      </View>
      {tree ? <ThreadBranch row={tree} height={height} /> : null}
    </Animated.View>
  );
}
