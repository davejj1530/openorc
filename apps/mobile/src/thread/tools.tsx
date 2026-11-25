import { activityIdOf, isImageView, liveVerb, stateLabel, toolCallPresentation, type Block, type ToolIconName } from "@openorc/client";
import { router } from "expo-router";
import { memo, type ComponentType } from "react";
import { Keyboard, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Hammer,
  Image as ImageIcon,
  Lightbulb,
  Search,
  WorkAgent,
  WorkCommand,
  WorkDelegate,
  WorkEdit,
  WorkMessage,
  WorkRead,
  WorkSearch,
} from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { confirm } from "../ui/motion";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { ImageTile } from "./images";
import { useOpen } from "./disclosure";
import { TranscriptPressable } from "./TranscriptPressable";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** How the phone draws each tool icon the transcript logic names. */
export const toolIcons = { Check, FileText, Globe, Hammer, Search, WorkCommand, WorkDelegate, WorkEdit, WorkMessage, WorkRead, WorkSearch } satisfies Record<ToolIconName, ComponentType<IconProps>>;

/**
 * Opens a call's detail in the tool sheet. The sheet reads the call from the run, so it follows it live. The keyboard
 * goes first, as it would cover the sheet's lower part.
 */
export function openTool(block: ToolBlock, runId: string) {
  Keyboard.dismiss();
  if (block.subagent) return router.push({ pathname: "/thread/[id]", params: { id: block.subagent.threadId } });
  router.push({ pathname: "/tool", params: { runId: block.runId ?? runId, id: block.id } });
}

/** Where a call stands: running, or how it ended. */
export function toolState(block: ToolBlock): string {
  if (!block.done) return "running";
  return block.status ?? (block.isError ? "error" : "success");
}

function ToolStatus({ block }: { block: ToolBlock }) {
  if (!block.done) return <WorkingMark size={14} />;
  if (block.isError || (block.status && block.status !== "success")) return <Text className="text-xs text-ink-4">{stateLabel(block.status ?? "error")}</Text>;
  return null;
}

/**
 * A call as one quiet row: its icon, verb and object. Tapping it opens the call. `label` says what the tap opens in
 * place of the verb and object, as under a visualization, whose row opens its source.
 */
export const PlainToolRow = memo(function PlainToolRow({ block, runId, label: named }: { block: ToolBlock; runId: string; label?: string }) {
  const presentation = toolCallPresentation(block.name, block.input);
  const Icon = toolIcons[presentation.icon];
  const label = named ?? (block.done ? presentation.verb : liveVerb(presentation.verb));
  const object = named ? "" : presentation.object;
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityLabel={[label, object].filter(Boolean).join(" ")}
        onPress={() => openTool(block, runId)}
        hitSlop={{ top: 5, bottom: 5 }}
        className="min-h-control-row flex-row items-center gap-2 rounded-sm active:opacity-60"
      >
        <Icon size={16} className={block.isError ? "text-bad" : "text-ink-4"} />
        <Text className={cn("text-ink-4", toolState(block) === "error" && "text-bad")}>{label}</Text>
        {object ? (
          <Text numberOfLines={1} className="min-w-0 flex-shrink font-mono text-xs text-ink-3">
            {object}
          </Text>
        ) : null}
        <ToolStatus block={block} />
      </TranscriptPressable>
      {block.progress ? <Text className="ml-6 text-xs leading-4.5 text-ink-4">{block.progress}</Text> : null}
    </View>
  );
});

/** "Thought for 12 seconds", or "Thinking" while it runs. */
function thoughtWords(block: Extract<Block, { kind: "thinking" }>): string {
  if (block.endedAt === null) return "Thinking";
  const seconds = Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000));
  const time = seconds < 60 ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const ended = block.status && block.status !== "success" ? ` · ${stateLabel(block.status)}` : "";
  return `Thought for ${time}${ended}`;
}

/** How long the agent reasoned, opened on demand under a thin rule. Claude often sends no text; then nothing unfolds. */
export const ThinkingRow = memo(function ThinkingRow({ block }: { block: Extract<Block, { kind: "thinking" }> }) {
  const [open, setOpen] = useOpen(`thinking:${block.id}`, false);
  const live = block.endedAt === null;
  const text = block.text.trim();
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={text ? { expanded: open } : undefined}
        disabled={!text}
        onPress={() => setOpen(!open)}
        className="min-h-touch flex-row items-center gap-2 active:opacity-60"
      >
        {live ? <WorkingMark kind="thinking" /> : <Lightbulb size={16} className="text-ink-4" />}
        <Text className="text-ink-4">{thoughtWords(block)}</Text>
        {text ? (
          <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
            <ChevronDown size={14} className="text-ink-4" />
          </View>
        ) : null}
      </TranscriptPressable>
      {text && open ? (
        <View className="mb-1 ml-2 gap-2 border-line pl-3" style={{ borderLeftWidth: 1.5 }}>
          {text
            .split(/\n\s*\n/)
            .filter((paragraph) => paragraph.trim())
            .map((paragraph, index) => (
              <Text key={index} prose className="leading-5.5 text-ink-4">
                {paragraph}
              </Text>
            ))}
        </View>
      ) : null}
    </View>
  );
});

function viewWords(status: string): string {
  if (status === "running") return "Viewing image";
  if (status === "success") return "Viewed image";
  if (status === "error") return "Image viewing failed";
  return "Image viewing interrupted";
}

/** An image the agent looked at, open by default as on the desktop. Its file stays on the Mac and comes by the activity. */
function ImageViewRow({ block, runId }: { block: Extract<Block, { kind: "activity" }>; runId: string }) {
  const [open, setOpen] = useOpen(`activity:${block.id}`, true);
  const path = (block.detail as { path?: unknown } | undefined)?.path;
  const name = typeof path === "string" ? path.split(/[\\/]/).pop() : undefined;
  const failed = block.status === "error";
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-control-row flex-row items-center gap-2 active:opacity-60"
      >
        <ImageIcon size={16} className={failed ? "text-bad" : "text-ink-4"} />
        <Text className={cn("text-ink-4", failed && "text-bad")}>{viewWords(block.status)}</Text>
        {name ? (
          <Text numberOfLines={1} className="min-w-0 flex-shrink font-mono text-xs text-ink-3">
            {name}
          </Text>
        ) : null}
        {block.status === "running" ? <WorkingMark size={14} /> : null}
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <ChevronRight size={12} className="text-ink-4" />
        </View>
      </TranscriptPressable>
      {open && block.status === "success" && name ? (
        <View className="ml-6 mt-1">
          <ImageTile asset={{ kind: "activity", runId: block.runId ?? runId, activityId: activityIdOf(block.id) }} label={name} />
        </View>
      ) : null}
    </View>
  );
}

/** The hue an activity's icon takes: a failure in bad, a finished agent hand-off with the agent mark. */
export const ActivityRow = memo(function ActivityRow({ block, runId }: { block: Extract<Block, { kind: "activity" }>; runId: string }) {
  if (isImageView(block)) return <ImageViewRow block={block} runId={runId} />;
  return <Activity block={block} />;
});

function Activity({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const [open, setOpen] = useOpen(`activity:${block.id}`, false);
  const live = block.status === "running";
  const showText = Boolean(block.text && (live || open || block.status === "error"));
  const expandable = Boolean(block.text);
  const finishedAgent = block.status === "success" && /agent|finished|completed/i.test(block.label);
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded: open } : undefined}
        disabled={!expandable}
        onPress={() => setOpen(!open)}
        className="min-h-control-row flex-row items-center gap-2 active:opacity-60"
      >
        {finishedAgent ? <WorkAgent size={16} className="text-ink-4" /> : <WorkMessage size={16} className={block.status === "error" ? "text-bad" : "text-ink-4"} />}
        <Text className={cn("text-ink-4", block.status === "error" && "text-bad")}>{block.label}</Text>
        {live ? <WorkingMark size={14} /> : null}
        {!live && block.status !== "success" ? <Text className="text-xs text-ink-4">{stateLabel(block.status)}</Text> : null}
        {expandable ? (
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <ChevronRight size={12} className="text-ink-4" />
          </View>
        ) : null}
      </TranscriptPressable>
      {showText ? (
        <Text prose className="ml-6 text-ink-3">
          {block.text}
        </Text>
      ) : null}
    </View>
  );
}

/** The step mark the work rail draws: an empty ring, a turning loader, or an ink check that lands with an overshoot. */
export function StepMark({ state, arrived }: { state: "pending" | "running" | "done"; arrived: boolean }) {
  const still = useReducedMotion();
  return (
    <View className="h-control-md w-4 items-center justify-center">
      {state === "running" ? <WorkingMark /> : null}
      {state === "done" ? (
        <Animated.View className="size-4 items-center justify-center rounded-full bg-ink" style={arrived && !still ? confirm : undefined}>
          <Check size={11} className="text-surface" />
        </Animated.View>
      ) : null}
      {state === "pending" ? <View className="size-3.5 rounded-full border-surface-3" style={{ borderWidth: 1.5 }} /> : null}
    </View>
  );
}
