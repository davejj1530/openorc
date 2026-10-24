import { activityIdOf, isCheckCommand, isImageView, liveVerb, stateLabel, toolCallPresentation, toolIntent, toolResult, type Block, type ToolIconName } from "@openorc/client";
import { router } from "expo-router";
import { memo, useRef, type ComponentType } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  FileText,
  Globe,
  Hammer,
  Image as ImageIcon,
  Lightbulb,
  Search,
  Terminal,
  WorkAgent,
  WorkCommand,
  WorkDelegate,
  WorkEdit,
  WorkMessage,
  WorkRead,
  WorkSearch,
  X,
} from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { confirm } from "../ui/motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { ImageTile } from "./images";
import { useOpen } from "./disclosure";

export type ToolBlock = Extract<Block, { kind: "tool" }>;

/** How the phone draws each tool icon the transcript logic names. */
export const toolIcons = { Check, FileText, Globe, Hammer, Search, WorkCommand, WorkDelegate, WorkEdit, WorkMessage, WorkRead, WorkSearch } satisfies Record<ToolIconName, ComponentType<IconProps>>;

/** Opens a call's detail in the tool sheet. The sheet reads the call from the run, so it follows it live. */
export function openTool(block: ToolBlock, runId: string) {
  router.push({ pathname: "/tool", params: { runId: block.runId ?? runId, id: block.id } });
}

/** Where a call stands: running, or how it ended. */
export function toolState(block: ToolBlock): string {
  if (!block.done) return "running";
  return block.status ?? (block.isError ? "error" : "success");
}

function ToolStatus({ block }: { block: ToolBlock }) {
  if (!block.done) return <Spinner size={14} />;
  if (block.isError || (block.status && block.status !== "success")) return <Text className="text-xs text-ink-4">{stateLabel(block.status ?? "error")}</Text>;
  return null;
}

/** A call as one quiet row: its icon, verb and object. Tapping it opens the call. */
const PlainToolRow = memo(function PlainToolRow({ block, runId }: { block: ToolBlock; runId: string }) {
  const { icon, verb, object } = toolCallPresentation(block.name, block.input);
  const Icon = toolIcons[icon];
  const label = block.done ? verb : liveVerb(verb);
  return (
    <View>
      <Pressable
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
      </Pressable>
      {block.progress ? <Text className="ml-6 text-xs leading-4.5 text-ink-4">{block.progress}</Text> : null}
    </View>
  );
});

/** The last line a finished command printed, or what a running one is for. */
function commandLine(block: ToolBlock): string {
  if (!block.done) return toolIntent(block) ?? "";
  if (block.output === undefined || block.output === null) return "";
  return (
    toolResult(block.output)
      .text.trim()
      .split("\n")
      .findLast((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** Running, then the result in its place with one overshoot. Only a live command animates the swap. */
function CommandStatus({ state, check }: { state: string; check: boolean }) {
  const first = useRef(state);
  const still = useReducedMotion();
  if (state === "running")
    return (
      <View className="flex-row items-center gap-1.5">
        <Spinner size={14} />
        <Text className="text-xs leading-4 text-ink-4">Running</Text>
      </View>
    );
  const passed = state === "success";
  const word = check ? "Passed" : "Done";
  const settled = state !== first.current && !still;
  return (
    <Animated.View className="flex-row items-center gap-1.5" style={settled ? confirm : undefined}>
      {passed ? <CircleCheck size={14} className="text-ok" /> : <X size={14} className="text-bad" />}
      <Text className={cn("text-xs leading-4", passed ? "text-ok" : "text-bad")}>{passed ? word : stateLabel(state)}</Text>
    </Animated.View>
  );
}

/** A command the agent ran, as an r16 card: the command, a status that trades places with its result, its last line. */
export const CommandCard = memo(function CommandCard({ block, runId, inset = false }: { block: ToolBlock; runId: string; inset?: boolean }) {
  const command = toolCallPresentation(block.name, block.input).object;
  const state = toolState(block);
  const line = commandLine(block);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${block.done ? "Ran" : liveVerb("Ran")} ${command}${state === "running" || state === "success" ? "" : `, ${stateLabel(state)}`}`}
      onPress={() => openTool(block, runId)}
      className={cn("gap-2 rounded-xl px-3.5 py-3 active:opacity-80", inset ? "bg-surface-2" : "bg-surface")}
    >
      <View className="min-h-4 flex-row items-center gap-2">
        <Terminal size={16} className="text-ink-4" />
        <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-xs leading-4">
          {command || "Command"}
        </Text>
        <CommandStatus state={state} check={isCheckCommand(command)} />
      </View>
      {line ? (
        <Text numberOfLines={1} className="pl-6 font-mono text-xs leading-4.5 text-ink-4">
          {line}
        </Text>
      ) : null}
      {block.progress ? <Text className="pl-6 font-mono text-xs leading-4.5 text-ink-4">{block.progress}</Text> : null}
    </Pressable>
  );
});

/** A call: a command as its own card, anything else as one quiet row. */
export const ToolRow = memo(function ToolRow({ block, runId, inset = false }: { block: ToolBlock; runId: string; inset?: boolean }) {
  if (toolCallPresentation(block.name, block.input).verb === "Ran") return <CommandCard block={block} runId={runId} inset={inset} />;
  return <PlainToolRow block={block} runId={runId} />;
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
      <Pressable
        accessibilityRole="button"
        accessibilityState={text ? { expanded: open } : undefined}
        disabled={!text}
        onPress={() => setOpen(!open)}
        className="h-8 flex-row items-center gap-2 active:opacity-60"
      >
        {live ? <Spinner /> : <Lightbulb size={16} className="text-ink-4" />}
        <Text className="text-ink-4">{thoughtWords(block)}</Text>
        {text ? (
          <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
            <ChevronDown size={14} className="text-ink-4" />
          </View>
        ) : null}
      </Pressable>
      {text && open ? (
        <View className="mb-1 ml-2 gap-2 border-line pl-3" style={{ borderLeftWidth: 1.5 }}>
          {text
            .split(/\n\s*\n/)
            .filter((paragraph) => paragraph.trim())
            .map((paragraph, index) => (
              <Text key={index} className="leading-5.5 text-ink-4">
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
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="min-h-control-row flex-row items-center gap-2 active:opacity-60">
        <ImageIcon size={16} className={failed ? "text-bad" : "text-ink-4"} />
        <Text className={cn("text-ink-4", failed && "text-bad")}>{viewWords(block.status)}</Text>
        {name ? (
          <Text numberOfLines={1} className="min-w-0 flex-shrink font-mono text-xs text-ink-3">
            {name}
          </Text>
        ) : null}
        {block.status === "running" ? <Spinner size={14} /> : null}
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <ChevronRight size={12} className="text-ink-4" />
        </View>
      </Pressable>
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
      <Pressable
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded: open } : undefined}
        disabled={!expandable}
        onPress={() => setOpen(!open)}
        className="min-h-control-row flex-row items-center gap-2 active:opacity-60"
      >
        {finishedAgent ? <WorkAgent size={16} className="text-ink-4" /> : <WorkMessage size={16} className={block.status === "error" ? "text-bad" : "text-ink-4"} />}
        <Text className={cn("text-ink-4", block.status === "error" && "text-bad")}>{block.label}</Text>
        {live ? <Spinner size={14} /> : null}
        {!live && block.status !== "success" ? <Text className="text-xs text-ink-4">{stateLabel(block.status)}</Text> : null}
        {expandable ? (
          <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
            <ChevronRight size={12} className="text-ink-4" />
          </View>
        ) : null}
      </Pressable>
      {showText ? <Text className="ml-6 text-ink-3">{block.text}</Text> : null}
    </View>
  );
}

/** The step mark the work rail draws: an empty ring, a turning loader, or an ink check that lands with an overshoot. */
export function StepMark({ state, arrived }: { state: "pending" | "running" | "done"; arrived: boolean }) {
  const still = useReducedMotion();
  return (
    <View className="h-control-md w-4 items-center justify-center">
      {state === "running" ? <Spinner /> : null}
      {state === "done" ? (
        <Animated.View className="size-4 items-center justify-center rounded-full bg-ink" style={arrived && !still ? confirm : undefined}>
          <Check size={11} className="text-surface" />
        </Animated.View>
      ) : null}
      {state === "pending" ? <View className="size-3.5 rounded-full border-surface-3" style={{ borderWidth: 1.5 }} /> : null}
    </View>
  );
}
