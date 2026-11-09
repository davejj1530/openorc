import type { TaskPriority, TaskStatus } from "@openorc/protocol";
import type { ComponentType } from "react";
import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { Archive, CircleCheck, Minus, Signal, SignalHigh, SignalLow, SignalMedium } from "../generated/icons";
import type { IconProps } from "../ui/icon";
import { useColors } from "../ui/mode";

const SIZE = 16;

/** The desktop's ring at 16 pt: open for the backlog, in the attention tone for a proposal. */
function Ring({ color }: { color: string }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16">
      <Circle cx={8} cy={8} r={5.25} stroke={color} strokeWidth={1.5} fill="none" />
    </Svg>
  );
}

/** Work under way: an arc in ink from the top, over the faint track. */
function Arc({ ink, track }: { ink: string; track: string }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16" style={{ transform: [{ rotate: "-90deg" }] }}>
      <Circle cx={8} cy={8} r={6} stroke={track} strokeWidth={2} fill="none" />
      <Circle cx={8} cy={8} r={6} stroke={ink} strokeWidth={2} strokeLinecap="round" strokeDasharray="15 37.7" fill="none" />
    </Svg>
  );
}

/**
 * A task's status as the desktop's task list marks it (components/status.tsx): an arc for work under way, the attention
 * dot for review, an attention ring for a proposal, an open ring for the backlog, a check for done. Faint parts take the
 * line's strong tone, as the phone's usage ring draws its track, so they hold up at a phone's distance.
 */
export function TaskStatusMark({ status }: { status: TaskStatus }) {
  const colors = useColors();
  switch (status) {
    case "proposed":
      return <Ring color={colors.attention} />;
    case "backlog":
      return <Ring color={colors["line-strong"]} />;
    case "in_progress":
      return <Arc ink={colors.ink} track={colors["line-strong"]} />;
    case "review":
      return (
        <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16">
          <Circle cx={8} cy={8} r={4} fill={colors.attention} />
        </Svg>
      );
    case "done":
      return <CircleCheck size={SIZE} className="text-ok" />;
    case "archived":
      return <Archive size={SIZE} className="text-ink-4" />;
  }
}

const priorityIcons: Record<Exclude<TaskPriority, "none">, ComponentType<IconProps>> = { low: SignalLow, medium: SignalMedium, high: SignalHigh, urgent: Signal };

/**
 * A task's priority as the desktop's signal bars, the full bars in the bad tone for urgent. The bars a priority leaves
 * unlit stay faint behind it, so one short bar still reads as a level at a phone's size; none is a dash as faint.
 */
export function PriorityMark({ priority }: { priority: TaskPriority }) {
  if (priority === "none") return <Minus size={SIZE} className="text-line-strong" />;
  const Icon = priorityIcons[priority];
  return (
    <View>
      <Signal size={SIZE} className="text-line-strong" />
      <View className="absolute inset-0">
        <Icon size={SIZE} className={priority === "urgent" ? "text-bad" : "text-ink-3"} />
      </View>
    </View>
  );
}
