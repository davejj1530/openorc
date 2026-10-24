import {
  chipCalls,
  chipTitle,
  isLive,
  liveHeadline,
  liveSectionLabel,
  receiptItems,
  useTicking,
  workDuration,
  workEntries,
  type Block,
  type LiveHeadline,
  type PlanItem,
  type WorkChip,
  type WorkEntry,
  type WorkPhase,
  type WorkSection,
} from "@openorc/client";
import { memo, useMemo, useRef, useState, type ComponentType } from "react";
import { Pressable, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { Brain, ChevronDown, ChevronRight, CircleCheck, FileText, Folder, Globe, Hammer, Lightbulb, Search, Terminal, WorkDelegate } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { arrive } from "../ui/motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { client } from "../client";
import { useRunRead } from "../run-read";
import { useOpen } from "./disclosure";
import { Markdown } from "./Markdown";
import type { Row } from "./rows";
import { keepPhases, phaseDetail } from "./work-entries";
import { ActivityRow, openTool, StepMark, ThinkingRow, ToolRow } from "./tools";

type WorkRowProps = Extract<Row, { kind: "work" }>;

const CHIP_LIMIT = 6;
const receiptIcons = { thought: Lightbulb, steps: CircleCheck, check: Terminal } as const;
const chipIcons: Record<WorkChip["kind"], ComponentType<IconProps>> = {
  file: FileText,
  edit: FileText,
  folder: Folder,
  query: Search,
  command: Terminal,
  intent: Terminal,
  web: Globe,
  tool: Hammer,
  agent: WorkDelegate,
  memory: Brain,
};

/** A part of the work arriving while the turn runs rises in; one loaded from history is simply there. */
function useArriving(live: boolean): boolean {
  const still = useReducedMotion();
  return useRef(live).current && !still;
}

/** Steps inside the card: a call as its row (commands on the card's fill), a thought or an activity as its own. */
function Blocks({ blocks, runId }: { blocks: Block[]; runId: string }) {
  return (
    <View className="gap-1">
      {blocks.map((block) => {
        switch (block.kind) {
          case "tool":
            return <ToolRow key={block.id} block={block} runId={runId} inset />;
          case "thinking":
            return <ThinkingRow key={block.id} block={block} />;
          case "activity":
            return <ActivityRow key={block.id} block={block} runId={runId} />;
          case "message":
            return (
              <Text key={block.id} className="text-ink-3">
                {block.text}
              </Text>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

/** What is happening now, in ink, arriving afresh as it changes; the folded line adds how long it has been going. */
function LiveWords({ headline, elapsed = false }: { headline: LiveHeadline; elapsed?: boolean }) {
  const now = useTicking(elapsed && headline.since !== undefined);
  const still = useReducedMotion();
  return (
    <>
      <Animated.View key={headline.label} className="min-w-0 flex-shrink" style={still ? undefined : arrive}>
        <Text numberOfLines={1}>{headline.label}</Text>
      </Animated.View>
      {elapsed && headline.since !== undefined ? (
        <Text className="ml-auto text-xs text-ink-4 tabular-nums" accessibilityElementsHidden>
          {workDuration(now - headline.since)}
        </Text>
      ) : null}
    </>
  );
}

/** One row of what a step touched: its mark, its name, a faint detail and note, an edit's line counts. */
function Chip({ chip, live, runId }: { chip: WorkChip; live: boolean; runId: string }) {
  const Icon = chipIcons[chip.kind];
  const call = chipCalls(chip).findLast((block) => block.kind === "tool");
  const named = chip.kind === "file" || chip.kind === "edit" || chip.kind === "folder";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chip.title}
      disabled={!call}
      onPress={() => call && openTool(call, runId)}
      className="-mx-2 h-7 flex-row items-center gap-2 rounded-md px-2 active:bg-surface-2"
    >
      <Icon size={14} className="text-ink-3" />
      <Text numberOfLines={1} className={cn("min-w-0 flex-shrink text-ink-2", named && "text-ink", chip.kind === "command" && "font-mono text-xs", live && "text-ink")}>
        {chip.label}
      </Text>
      {chip.detail ? (
        <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-ink-4">
          {chip.detail}
        </Text>
      ) : (
        <View className="flex-1" />
      )}
      {chip.note ? <Text className="text-xs text-ink-4 tabular-nums">{chip.note}</Text> : null}
      {chip.added ? <Text className="font-mono text-xs text-ok">+{chip.added}</Text> : null}
      {chip.removed ? <Text className="font-mono text-xs text-bad">−{chip.removed}</Text> : null}
    </Pressable>
  );
}

/** One kind of work in a phase: its verb in a quiet column, then what it touched. The verb opens the calls themselves. */
function Section({ section, live, runId }: { section: WorkSection; live: boolean; runId: string }) {
  const [calls, setCalls] = useOpen(`section:${section.id}`, false);
  const [all, setAll] = useState(false);
  const activities = section.blocks.filter((block) => block.kind === "activity");
  if (!section.chips.length && activities.length) return <Blocks blocks={activities} runId={runId} />;
  const running = live && section.blocks.some(isLive);
  const first = section.chips.slice(0, CHIP_LIMIT);
  // The call under way stays in view, in place of the last row that fits.
  const current = running ? section.chips.findLast((chip) => chip.blocks.some(isLive)) : undefined;
  const fitting = current && !first.includes(current) ? [...first.slice(0, -1), current] : first;
  const shown = all ? section.chips : fitting;
  return (
    <View className="gap-1">
      <View className="flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: calls }}
          onPress={() => setCalls(!calls)}
          className="min-h-7 min-w-18 flex-row items-center gap-1 self-start active:opacity-60"
        >
          <Text className="text-xs leading-4 text-ink-4">{running ? liveSectionLabel(section.label) : section.label}</Text>
          {calls ? <ChevronDown size={10} className="text-ink-4" /> : null}
        </Pressable>
        <View className="min-w-0 flex-1 gap-px">
          {shown.map((chip) => (
            <Chip key={chip.key} chip={chip} live={live && chip.blocks.some(isLive)} runId={runId} />
          ))}
          {section.chips.length > shown.length ? (
            <Pressable accessibilityRole="button" onPress={() => setAll(true)} className="h-7 justify-center pl-5.5">
              <Text className="text-xs text-ink-4">{section.chips.length - shown.length} more</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {calls ? <Blocks blocks={section.blocks} runId={runId} /> : null}
    </View>
  );
}

/** A phase's words; the live phase reads them from the run as they arrive (see `phaseDetail`). */
function PhaseDetail({ phase, live, runId }: { phase: WorkPhase; live: boolean; runId: string }) {
  const detail = useRunRead(client.runs, (runs) => (live ? phaseDetail(runs, runId, phase) : phase.detail), live);
  return detail ? <Text className="text-ink-3">{detail}</Text> : null;
}

function PhaseBody({ phase, live, runId }: { phase: WorkPhase; live: boolean; runId: string }) {
  // A phase named after its one call ("Run the desktop tests") opens straight to that call.
  const section = phase.sections.length === 1 ? phase.sections[0]! : null;
  const only = section?.chips.length === 1 ? section.chips[0]! : null;
  if (only && chipTitle(only) === phase.title && !phase.extras.length) return <Blocks blocks={chipCalls(only)} runId={runId} />;
  return (
    <View className="gap-2.5 pb-3 pt-0.5">
      <PhaseDetail phase={phase} live={live} runId={runId} />
      {phase.narration?.kind === "message" ? <Markdown text={phase.narration.text} streaming={phase.narration.streaming} tone="note" /> : null}
      {phase.thoughts.length ? (
        <View className="gap-0.5">
          {phase.thoughts.map((thought, index) => (
            <View key={index} className="flex-row items-center gap-2">
              <View className="size-1 rounded-full bg-ink-4" />
              <Text className="min-w-0 flex-1 text-xs text-ink-3">{thought.title}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {phase.sections.map((item) => (
        <Section key={item.id} section={item} live={live} runId={runId} />
      ))}
      {phase.extras.length ? <Blocks blocks={phase.extras} runId={runId} /> : null}
    </View>
  );
}

/** Open while it is the live phase, folded once it is done, unless the reader chose. */
const Phase = memo(function Phase({ phase, headline, runId, live }: { phase: WorkPhase; headline: LiveHeadline | null; runId: string; live: boolean }) {
  const running = headline !== null;
  const [open, setOpen] = useOpen(`phase:${phase.id}`, running);
  const arriving = useArriving(live);
  const expandable = phase.sections.length > 0 || phase.extras.length > 0 || phase.thoughts.length > 0 || Boolean(phase.detail || phase.narration);
  return (
    <Animated.View style={arriving ? arrive : undefined}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded: open } : undefined}
        disabled={!expandable}
        onPress={() => setOpen(!open)}
        className="flex-row gap-2.5 active:opacity-60"
      >
        <StepMark state={running ? "running" : "done"} arrived={arriving} />
        <View className="min-h-control-md min-w-0 flex-1 flex-row items-center gap-2">
          {headline ? (
            <LiveWords headline={headline} />
          ) : (
            <Text numberOfLines={1} className="min-w-0 flex-shrink text-ink-2">
              {phase.title}
            </Text>
          )}
          {expandable && open ? (
            <View className="ml-auto" style={{ transform: [{ rotate: "90deg" }] }}>
              <ChevronRight size={12} className="text-ink-4" />
            </View>
          ) : null}
        </View>
      </Pressable>
      {expandable && open ? (
        <View className="pl-6.5">
          <PhaseBody phase={phase} live={running} runId={runId} />
        </View>
      ) : null}
    </Animated.View>
  );
});

const planStates: Record<PlanItem["status"], (live: boolean) => "pending" | "running" | "done"> = {
  completed: () => "done",
  in_progress: (live) => (live ? "running" : "pending"),
  pending: () => "pending",
};

/** The agent's plan as steps that check off in place, the one it is on in ink. */
function Plan({ items, live }: { items: PlanItem[]; live: boolean }) {
  const arriving = useArriving(live);
  return (
    <View>
      {items.map((item, index) => (
        <View key={index} className="min-h-control-md flex-row items-center gap-2.5">
          <StepMark state={planStates[item.status](live)} arrived={arriving} />
          <Text className={cn("min-w-0 flex-1 text-ink-2", item.status === "in_progress" && "text-ink")}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}

/** Where a plan stands: the step it is on, and how far along the track it is. */
function planProgress(items: PlanItem[]): { count: string; progress: number } {
  const done = items.filter((item) => item.status === "completed").length;
  const current = items.findIndex((item) => item.status !== "completed");
  const working = items.some((item) => item.status === "in_progress") ? 0.5 : 0;
  if (current < 0) return { count: "Done", progress: 1 };
  return { count: `Step ${current + 1} of ${items.length}`, progress: (done + working) / items.length };
}

function StepsHead({ entries }: { entries: WorkEntry[] }) {
  const plan = entries.findLast((entry): entry is Extract<WorkEntry, { kind: "plan" }> => entry.kind === "plan");
  if (!plan) return null;
  const { count, progress } = planProgress(plan.items);
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 leading-4">Plan</Text>
        <Text className="text-xs leading-4 text-ink-4 tabular-nums">{count}</Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} className="h-0.5 overflow-hidden rounded-full bg-surface-3">
        <View className="h-full rounded-full bg-ink" style={{ width: `${progress * 100}%` }} />
      </View>
    </View>
  );
}

/** The turn's work as one r20 card of steps: with a plan, "Step k of n" over its track; without one, the phases. */
function StepsCard({ entries, headline, live, runId }: { entries: WorkEntry[]; headline: LiveHeadline | null; live: boolean; runId: string }) {
  return (
    <View className="gap-4 rounded-3xl bg-surface px-4.5 pb-3.5 pt-4">
      <StepsHead entries={entries} />
      <View>
        {entries.map((entry) => {
          if (entry.kind === "phase") return <Phase key={entry.phase.id} phase={entry.phase} headline={headline?.entryId === entry.phase.id ? headline : null} runId={runId} live={live} />;
          if (entry.kind === "plan") return <Plan key={entry.id} items={entry.items} live={live} />;
          return <Blocks key={entry.id} blocks={entry.blocks} runId={runId} />;
        })}
        {headline && !headline.entryId ? (
          <View className="flex-row gap-2.5">
            <StepMark state="running" arrived={false} />
            <View className="min-h-control-md min-w-0 flex-1 flex-row items-center gap-2">
              <LiveWords headline={headline} />
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * What a turn's work came to, as one quiet row of icons and words under its head, and the work itself behind it:
 * open while the turn runs, folded once it is done, unless the reader chose. Folded and live, one line says what
 * the agent is doing now.
 */
export const WorkRow = memo(function WorkRow({ row }: { row: WorkRowProps }) {
  const phases = useRef(new Map<string, WorkPhase>());
  const entries = useMemo(() => keepPhases(workEntries(row.work), phases.current), [row.work]);
  const receipt = useMemo(() => receiptItems(row.work, entries.length, row.live), [row.work, entries.length, row.live]);
  const [open, setOpen] = useOpen(`work:${row.turnId}`, row.live);
  const now = row.now && row.now !== "reply" ? [row.now] : [];
  const headline = row.live && row.now !== "reply" ? liveHeadline(entries, now) : null;
  return (
    <View className="gap-3.5">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={receipt.map((item) => item.label).join(", ") || "Work"}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        className="min-h-4 flex-row flex-wrap items-center gap-x-4 gap-y-1 self-start active:opacity-60"
      >
        {receipt.map((item) => {
          const Icon = receiptIcons[item.kind];
          return (
            <View key={item.kind} className="flex-row items-center gap-1.5">
              <Icon size={14} className={item.failed ? "text-bad" : "text-ink-4"} />
              <Text className={cn("text-xs leading-4 text-ink-4 tabular-nums", item.failed && "text-bad")}>{item.label}</Text>
            </View>
          );
        })}
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <ChevronDown size={14} className="text-ink-4" />
        </View>
      </Pressable>
      {!open && headline ? (
        <View accessibilityRole="text" className="min-h-control-md flex-row items-center gap-2">
          <Spinner />
          <LiveWords headline={headline} elapsed />
        </View>
      ) : null}
      {open ? <StepsCard entries={entries} headline={headline} live={row.live} runId={row.runId} /> : null}
    </View>
  );
});
