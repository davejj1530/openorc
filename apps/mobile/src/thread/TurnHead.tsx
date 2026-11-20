import { personFirst } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import { memo } from "react";
import { View } from "react-native";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { Text } from "../ui/Text";
import { FIXED_HEIGHT, type Row } from "./rows";
import { useVoice, type Voice } from "./voices";

type HeadRow = Extract<Row, { kind: "head" }>;

const agentName = (voice: Voice | undefined) => (voice && isHarnessId(voice.agent) ? harnessShortName(voice.agent) : "Assistant");

/**
 * A turn's head, only on a turn that keeps one: the agent's mark and name where the agent changed from the turn
 * before, and in a cloud thread others are in, the first name of who sent the turn where its prompt does not say it.
 */
export const TurnHead = memo(function TurnHead({ row }: { row: HeadRow }) {
  const { voice, sender } = row;
  return (
    <View className="flex-row items-center gap-2" style={{ height: FIXED_HEIGHT.head }}>
      {voice ? <HarnessLogo agent={voice.agent} size={14} /> : null}
      {voice ? <Text className="leading-4">{agentName(voice)}</Text> : null}
      {sender === undefined ? null : <Text className={cn("text-xs leading-4 text-ink-3", voice && "ml-1")}>{personFirst(sender)}</Text>}
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
