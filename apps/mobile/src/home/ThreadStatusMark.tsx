import type { PrState } from "@openorc/protocol";
import { View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { AlertCircle, CircleHelp, GitPullRequest, LoaderCircle } from "../generated/icons";
import type { ThreadMark } from "./thread-row-model";

const pullTone: Record<PrState, string> = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" };

// Tailwind's animate-spin, which the desktop's spinner uses.
const spin = { to: { transform: [{ rotate: "360deg" }] } };

function Spinner() {
  const still = useReducedMotion();
  return (
    <Animated.View style={still ? undefined : { animationName: spin, animationDuration: "1s", animationIterationCount: "infinite", animationTimingFunction: "linear" }}>
      <LoaderCircle size={14} className="text-ink-4" />
    </Animated.View>
  );
}

function Glyph({ mark }: { mark: ThreadMark }) {
  switch (mark.kind) {
    case "waiting":
      return <CircleHelp size={14} className="text-attention" />;
    case "running":
      return <Spinner />;
    case "failed":
      return <AlertCircle size={14} className="text-bad" />;
    case "unread":
      return <View className="size-1.75 rounded-full bg-attention" />;
    case "pull":
      return <GitPullRequest size={14} className={pullTone[mark.state]} />;
  }
}

/** A row's 16 pt status lead. Empty when the thread has nothing to report. */
export function ThreadStatusMark({ mark }: { mark: ThreadMark | null }) {
  return (
    <View className="size-4 items-center justify-center" accessible={mark !== null} accessibilityLabel={mark?.label}>
      {mark ? <Glyph mark={mark} /> : null}
    </View>
  );
}
