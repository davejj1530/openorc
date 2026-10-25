import { turnStatus, turnStatusWords, useTicking } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { memo } from "react";
import { View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { arrive } from "../ui/motion";
import { Text } from "../ui/Text";
import { useRowState } from "./row-state";
import { FIXED_HEIGHT, type Row } from "./rows";
import { useVoice, type Voice } from "./voices";

type HeadRow = Extract<Row, { kind: "head" }>;

const agentName = (voice: Voice | undefined) => (voice && isHarnessId(voice.agent) ? harnessShortName(voice.agent) : "Assistant");

/**
 * One head per turn: the agent's mark and name, then its model and a status that swaps in place as the turn moves
 * from working to writing to done. A turn loaded from history mounts in its final state and does not animate.
 */
export const TurnHead = memo(function TurnHead({ row }: { row: HeadRow }) {
  const voice = useVoice(row.runId);
  const now = useTicking(row.live);
  const status = turnStatus(row, now);
  // The status this turn's head first showed in this view; a view the list recycles starts over for its new turn.
  const [first] = useRowState(row.key, () => status.kind);
  const still = useReducedMotion();
  const name = agentName(voice);
  const words = [voice?.model, turnStatusWords(status)].filter(Boolean).join(" · ");
  const swapped = status.kind !== first && !still;
  return (
    <View className="flex-row items-center gap-2" style={{ height: FIXED_HEIGHT.head }}>
      {voice ? <HarnessLogo agent={voice.agent} size={14} /> : null}
      <Text className="leading-4">{name}</Text>
      {words ? (
        <Animated.View key={status.kind} className="min-w-0 flex-1" style={swapped ? arrive : undefined}>
          <Text numberOfLines={1} className={cn("text-xs leading-4 text-ink-4 tabular-nums", status.kind === "failed" && "text-bad")}>
            {words}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
});

type WaitingRow = Extract<Row, { kind: "waiting" }>;

/**
 * Above what a run outside the loaded conversation asks: its task's title, as its alert showed it, or for one of the
 * thread's own runs, its agent, as a turn head names it.
 */
export function WaitingHead({ row }: { row: WaitingRow }) {
  const voice = useVoice(row.runId);
  return (
    <View className="flex-row items-center gap-2" style={{ height: FIXED_HEIGHT.waiting }}>
      {row.title === null && voice ? <HarnessLogo agent={voice.agent} size={14} /> : null}
      <Text numberOfLines={1} className="shrink leading-4">
        {row.title ?? agentName(voice)}
      </Text>
    </View>
  );
}
