import { subagentStatusLabel, useTicking, workDuration, type Block, type SubagentCard } from "@openorc/client";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { useState } from "react";
import Animated from "react-native-reanimated";
import { ChevronDown, CircleCheck, CircleDashed, X } from "../generated/icons";
import { motion } from "../generated/tokens";
import { useColors } from "../ui/mode";
import { arriveAt, leave, turn } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { useOpen } from "./disclosure";
import { TranscriptPressable } from "./TranscriptPressable";
import { useRpcs } from "../client";

export function SubagentCards({ blocks }: { blocks: Extract<Block, { kind: "tool" }>[] }) {
  const children = useRpcs(
    "threads.get",
    blocks.map((block) => ({ id: block.subagent?.threadId ?? "" })),
  );
  blocks = blocks.filter((_, index) => children[index]?.data !== null);
  const label = blocks[0]?.subagent?.group ?? (blocks.length > 1 ? `${blocks.length} agents` : null);
  if (!blocks.length) return null;
  return (
    <View className="rounded-3xl bg-surface px-4 py-1">
      {label ? <Text className="pb-0.5 pt-3 text-base text-ink-4">{label}</Text> : null}
      {blocks.map((block, index) => (block.subagent ? <SubagentRow key={block.id} card={block.subagent} divider={index > 0} /> : null))}
    </View>
  );
}

function SubagentMark({ status }: { status: SubagentCard["status"] }) {
  if (status === "running") return <Spinner size={16} />;
  if (status === "no_updates") return <CircleDashed size={16} className="text-ink-4" />;
  return status === "completed" ? <CircleCheck size={16} className="text-ink-4" /> : <X size={16} className={status === "failed" ? "text-bad" : "text-ink-4"} />;
}

/** Details fold once they have all but faded, as Home's sub threads do. */
const FOLD_AFTER_MS = motion.duration.leave - 40;

/**
 * A sub thread in its parent's transcript, as Home draws one: the status in a 20 pt lead, the title at reading size,
 * what kind of agent it is, its state and time under it, and what it is doing while it works, all on the title's
 * column. The trailing chevron opens its prompt and result in place, turning as they arrive; closing, they fade first
 * and fold after.
 */
function SubagentRow({ card, divider }: { card: SubagentCard; divider: boolean }) {
  const [open, setOpen] = useOpen(`subagent:${card.threadId}`, false);
  const working = card.status === "running";
  const now = useTicking(working);
  const colors = useColors();
  const still = useReducedMotion();
  const [closing, setClosing] = useState(false);
  const shown = open && !closing;
  const details = closing ? leave : arriveAt(0);
  const toggle = () => {
    if (closing) return;
    if (!open || still) return setOpen(!open);
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      setOpen(false);
    }, FOLD_AFTER_MS);
  };
  return (
    <View style={divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line } : undefined}>
      <View className="flex-row">
        <TranscriptPressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${card.title}`}
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: card.threadId } })}
          className="min-h-touch min-w-0 flex-1 flex-row gap-3 py-2.5 active:opacity-60"
        >
          <View className="h-5.5 w-5 items-center justify-center">
            <SubagentMark status={card.status} />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-lg">
              {card.title}
            </Text>
            <Text className="text-detail text-ink-4 tabular-nums">
              {[card.agentType, subagentStatusLabel[card.status], workDuration((card.endedAt ?? now) - card.startedAt)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </TranscriptPressable>
        <TranscriptPressable
          accessibilityRole="button"
          accessibilityLabel={`Details for ${card.title}`}
          accessibilityState={{ expanded: shown }}
          onPress={toggle}
          // On the title's line, as Home's disclosures are.
          className="-mr-2.5 -mt-px size-touch items-center justify-center self-start rounded-full active:bg-surface-2"
        >
          <Animated.View style={turn(shown, still)}>
            <ChevronDown size={16} className="text-ink-4" />
          </Animated.View>
        </TranscriptPressable>
      </View>
      {working && card.progress ? (
        <Text numberOfLines={1} className="-mt-1 pb-2.5 pl-8 text-detail text-ink-4">
          {card.progress}
        </Text>
      ) : null}
      {open ? (
        <Animated.View style={still ? undefined : details} className="gap-3 pb-3.5 pl-8">
          <Text className="text-md text-ink-3">{card.prompt ?? subagentStatusLabel[card.status]}</Text>
          {card.result ? <Text className="text-md text-ink-3">{card.result}</Text> : null}
        </Animated.View>
      ) : null}
    </View>
  );
}
