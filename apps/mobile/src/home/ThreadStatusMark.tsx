import type { PrState } from "@openorc/protocol";
import { View } from "react-native";
import Animated from "react-native-reanimated";
import { AlertCircle, CircleHelp, GitPullRequest, LoaderCircle, Terminal } from "../generated/icons";
import type { ThreadMark } from "@openorc/client";
import { useReducedMotion } from "../ui/reduced-motion";

const pullTone: Record<PrState, string> = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" };

// Tailwind's animate-spin, which the desktop's spinner uses.
const spin = { to: { transform: [{ rotate: "360deg" }] } };

/** The faint spinner of a thread at work, turning unless motion is reduced. */
export function Spinner() {
  const still = useReducedMotion();
  return (
    <Animated.View style={still ? undefined : { animationName: spin, animationDuration: "1s", animationIterationCount: "infinite", animationTimingFunction: "linear" }}>
      <LoaderCircle size={16} className="text-ink-4" />
    </Animated.View>
  );
}

function Glyph({ mark }: { mark: ThreadMark }) {
  switch (mark.kind) {
    case "waiting":
      return <CircleHelp size={16} className="text-attention" />;
    case "running":
      return <Spinner />;
    case "failed":
      return <AlertCircle size={16} className="text-bad" />;
    case "unread":
      return <View className="size-2 rounded-full bg-attention" />;
    case "background":
      return <Terminal size={16} className="text-ink-4" />;
    case "pull":
      return <GitPullRequest size={16} className={pullTone[mark.state]} />;
  }
}

/**
 * How far each kind of 16 pt status glyph reaches left of its center on the title line, stroke included: the rings
 * (8.5 of 24 plus half the 1.75 stroke), the cross's and the pull request's left arms (6 of 24), the terminal's frame
 * (9 of 24 plus half the stroke), the 8 pt unread dot.
 */
export const REACH = { ring: 6.25, cross: 4.6, frame: 6.6, dot: 4 } as const;

const reaches: Record<ThreadMark["kind"], number> = { waiting: REACH.ring, running: REACH.ring, failed: REACH.ring, unread: REACH.dot, background: REACH.frame, pull: REACH.cross };

/** How far a row's status glyph reaches left of its center, so the tree's lines can stop a set gap short of it. */
export const markReach = (mark: ThreadMark | null): number | null => (mark ? reaches[mark.kind] : null);

/** A row's status in Home's lead column, its 16 pt glyph centered under the headings' glyphs. Empty when the thread has nothing to report. */
export function ThreadStatusMark({ mark }: { mark: ThreadMark | null }) {
  return (
    <View className="h-4 w-7 items-center justify-center" accessible={mark !== null} accessibilityLabel={mark?.label}>
      {mark ? <Glyph mark={mark} /> : null}
    </View>
  );
}
