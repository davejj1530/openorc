import { subagentStatusLabel, useTicking, workDuration, type Block, type SubagentCard } from "@openorc/client";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { ChevronRight, CircleCheck, CircleDashed, X } from "../generated/icons";
import { useColors } from "../ui/mode";
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
    <View className="rounded-3xl bg-surface px-3 py-1">
      {label ? <Text className="px-1 pb-1 pt-2 text-xs text-ink-4">{label}</Text> : null}
      {blocks.map((block, index) => (block.subagent ? <SubagentRow key={block.id} card={block.subagent} divider={index > 0} /> : null))}
    </View>
  );
}

function SubagentMark({ status }: { status: SubagentCard["status"] }) {
  if (status === "running") return <Spinner size={14} />;
  if (status === "no_updates") return <CircleDashed size={14} className="text-ink-4" />;
  return status === "completed" ? <CircleCheck size={14} className="text-ink-4" /> : <X size={14} className={status === "failed" ? "text-bad" : "text-ink-4"} />;
}

function SubagentRow({ card, divider }: { card: SubagentCard; divider: boolean }) {
  const [open, setOpen] = useOpen(`subagent:${card.threadId}`, false);
  const working = card.status === "running";
  const now = useTicking(working);
  const colors = useColors();
  return (
    <View style={divider ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line } : undefined}>
      <View className="flex-row items-center">
        <TranscriptPressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${card.title}`}
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: card.threadId } })}
          className="min-h-touch min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-60"
        >
          <SubagentMark status={card.status} />
          <View className="min-w-0 flex-1 gap-1">
            <Text numberOfLines={1} className="text-sm">
              {card.title}
            </Text>
            <Text className="text-xs text-ink-4 tabular-nums">
              {[card.agentType, subagentStatusLabel[card.status], workDuration((card.endedAt ?? now) - card.startedAt)].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </TranscriptPressable>
        <TranscriptPressable
          accessibilityRole="button"
          accessibilityLabel={`Details for ${card.title}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="size-touch items-center justify-center rounded-full active:bg-surface-2"
        >
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <ChevronRight size={13} className="text-ink-4" />
          </View>
        </TranscriptPressable>
      </View>
      {working && card.progress ? (
        <Text numberOfLines={1} className="pb-2 pl-5.5 text-xs text-ink-4">
          {card.progress}
        </Text>
      ) : null}
      {open ? (
        <View className="gap-3 pb-3">
          <Text className="text-sm text-ink-3">{card.prompt ?? subagentStatusLabel[card.status]}</Text>
          {card.result ? <Text className="text-sm text-ink-3">{card.result}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
