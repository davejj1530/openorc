import {
  firstThought,
  liveHeadline,
  receiptItems,
  stepCounts,
  stepLines,
  stepRows,
  stepThoughts,
  stepTitle,
  stepWaiting,
  useTicking,
  workDuration,
  workEntries,
  workObjects,
  type ActLine,
  type Block,
  type LiveHeadline,
  type PlanItem,
  type ReceiptItem,
  type StepThoughts,
  type WorkEntry,
  type WorkObject,
  type WorkPhase,
} from "@openorc/client";
import { memo, useCallback, useMemo, useRef, type ComponentType } from "react";
import { View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { ChevronDown, ChevronRight, CircleCheck, FileDiff, GitPullRequest, Globe, Lightbulb, Terminal, Upload, WorkDelegate, X } from "../generated/icons";
import { cn } from "../ui/cn";
import type { IconProps } from "../ui/icon";
import { arrive } from "../ui/motion";
import { Spinner } from "../ui/Spinner";
import { SweepText } from "../ui/SweepText";
import { Text } from "../ui/Text";
import { client } from "../client";
import { useRunRead } from "../run-read";
import { useOpen } from "./disclosure";
import { LineRow, ToolRow } from "./lines";
import { Markdown } from "./Markdown";
import { TranscriptPressable, WorkChoice } from "./TranscriptPressable";
import type { Row } from "./rows";
import { keepPhases, phaseDetail } from "./work-entries";
import { ActivityRow, StepMark, ThinkingRow } from "./tools";

type WorkRowProps = Extract<Row, { kind: "work" }>;

/** As on the Mac: a pull request reads as one, a push or a commit as sending, a failure as a cross. */
function receiptIcon(item: ReceiptItem): ComponentType<IconProps> {
  if (item.failed) return X;
  if (item.kind === "git") return item.label.startsWith("#") ? GitPullRequest : Upload;
  return { thought: Lightbulb, steps: CircleCheck, check: Terminal, tests: CircleCheck, changes: FileDiff, agents: WorkDelegate, sources: Globe }[item.kind];
}
/** A part of the work arriving while the turn runs rises in; one loaded from history is simply there. */
function useArriving(live: boolean): boolean {
  const still = useReducedMotion();
  return useRef(live).current && !still;
}

/** What a step shows beside its lines: a call as its lines, a thought or an activity as its own row. */
function Blocks({ blocks, runId }: { blocks: Block[]; runId: string }) {
  return (
    <View className="gap-1">
      {blocks.map((block) => {
        switch (block.kind) {
          case "tool":
            return <ToolRow key={block.id} block={block} runId={runId} />;
          case "thinking":
            return <ThinkingRow key={block.id} block={block} />;
          case "activity":
            return <ActivityRow key={block.id} block={block} runId={runId} />;
          case "message":
            return (
              <Text key={block.id} prose className="text-ink-3">
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
  // A thought with words says more than "Thinking" does.
  const words = headline.thought ?? headline.label;
  return (
    <>
      <Animated.View key={words} className="min-w-0 flex-shrink" style={still ? undefined : arrive}>
        <Text numberOfLines={1}>{words}</Text>
      </Animated.View>
      {elapsed && headline.since !== undefined ? (
        <Text className="ml-auto text-xs text-ink-4 tabular-nums" accessibilityElementsHidden>
          {workDuration(now - headline.since)}
        </Text>
      ) : null}
    </>
  );
}

/** How much of a thought being written shows: its newest words, from the start of a word. */
const THOUGHT = 220;
function newest(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= THOUGHT ? flat : `…${flat.slice(flat.indexOf(" ", flat.length - THOUGHT) + 1)}`;
}

/**
 * What the turn is doing between its calls, as a line that moves: its words shimmer and its seconds count. A thought
 * no step shows has its newest lines under it as they are written.
 */
function LiveLine({ headline }: { headline: LiveHeadline }) {
  const now = useTicking(headline.since !== undefined);
  const { thinking, aside } = headline;
  return (
    <View accessibilityRole="text">
      <View className="min-h-control-row flex-row items-center gap-2.5">
        {thinking ? <Lightbulb size={16} className="text-ink-4" /> : <Spinner size={14} />}
        <SweepText text={thinking ? "Thinking" : headline.label} className="flex-1 text-ink" sweeping />
        {headline.since === undefined ? null : (
          <Text className="text-xs text-ink-4 tabular-nums" accessibilityElementsHidden>
            {workDuration(now - headline.since)}
          </Text>
        )}
      </View>
      {aside ? (
        <Text prose numberOfLines={3} className="pb-1 pl-6.5 text-ink-3">
          {newest(aside)}
        </Text>
      ) : null}
    </View>
  );
}

/** A phase's words; the live phase reads them from the run as they arrive (see `phaseDetail`). */
function PhaseDetail({ phase, live, runId }: { phase: WorkPhase; live: boolean; runId: string }) {
  const detail = useRunRead(client.runs, (runs) => (live ? phaseDetail(runs, runId, phase) : phase.detail), live);
  return detail ? (
    <Text prose className="pb-1.5 text-ink-3">
      {detail}
    </Text>
  ) : null;
}

/** A step's thoughts as one line, the first of them said in its own words; tapping it shows them in full. */
function Thoughts({ id, thoughts }: { id: string; thoughts: StepThoughts }) {
  const [open, setOpen] = useOpen(`thoughts:${id}`, false);
  const paragraphs = thoughts.texts.flatMap((text) => text.split(/\n\s*\n/)).filter((paragraph) => paragraph.trim());
  if (!thoughts.titled.length && !paragraphs.length) return null;
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="-mx-2 min-h-touch flex-row items-center gap-2.5 rounded-xl px-2 active:bg-surface-2"
      >
        <Lightbulb size={16} className="text-ink-4" />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-ink-2">
          <Text className="text-ink-4">Thought </Text>
          {firstThought(thoughts)}
        </Text>
        {thoughts.took >= 1000 ? <Text className="text-xs text-ink-4 tabular-nums">{workDuration(thoughts.took)}</Text> : null}
      </TranscriptPressable>
      {open ? (
        <View className="gap-2 pb-2 pl-6.5">
          {thoughts.titled.map((thought, index) => (
            <Text key={index} prose className="text-ink-3">
              <Text prose className="text-ink-2">
                {thought.title}
              </Text>
              {thought.body ? ` ${thought.body}` : null}
            </Text>
          ))}
          {paragraphs.map((paragraph, index) => (
            <Text key={`text-${index}`} prose className="text-ink-3">
              {paragraph}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One step, as writing on the thread's own ground: what the agent said about it in full, or else its name, then
 * everything it did as a line each in the order it happened. Its name folds the lines to a count; while it runs, a
 * line that moves says what it is waiting on.
 */
/** What a step holds once open: its detail and thoughts, a line for each thing it did, then the rows that draw as themselves. */
function StepBody({ phase, objects, lines, running, runId }: { phase: WorkPhase; objects: WorkObject[]; lines: ActLine[]; running: boolean; runId: string }) {
  const { rows, alone } = useMemo(() => stepRows(phase, objects), [phase, objects]);
  const thoughts = useMemo(() => stepThoughts(phase), [phase]);
  return (
    <View>
      <PhaseDetail phase={phase} live={running} runId={runId} />
      <Thoughts id={phase.id} thoughts={thoughts} />
      {lines.map((line) => (
        <LineRow key={line.object.id} line={line} runId={runId} />
      ))}
      {rows.length ? <Blocks blocks={rows} runId={runId} /> : null}
      {alone.length ? <Blocks blocks={alone} runId={runId} /> : null}
    </View>
  );
}

const Step = memo(function Step({ phase, headline, runId, live, turn }: { phase: WorkPhase; headline: LiveHeadline | null; runId: string; live: boolean; turn: Block[] | undefined }) {
  const running = headline !== null;
  const objects = useMemo(() => workObjects(phase.blocks, turn ?? phase.blocks, live), [phase.blocks, turn, live]);
  const lines = useMemo(() => stepLines(phase, objects), [phase, objects]);
  const [open, setOpen] = useOpen(`phase:${phase.id}`, true);
  const arriving = useArriving(live);
  const title = stepTitle(phase, objects);
  const said = phase.narration?.kind === "message" ? phase.narration : null;
  // A step named after its one call would say that call twice: its line stands alone.
  const named = said === null && (phase.origin !== "summary" || lines.length !== 1);
  const shown = open || said !== null;
  const wait = stepWaiting(headline, title, objects);
  const counts = shown || phase.origin === "summary" ? "" : stepCounts(objects);
  return (
    <Animated.View style={arriving ? arrive : undefined} className="pt-2">
      {said ? <Markdown text={said.text} streaming={said.streaming} tone="note" /> : null}
      {named ? (
        <TranscriptPressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} className="min-h-touch flex-row items-center gap-2 active:opacity-60">
          <Text className={cn("min-w-0 flex-shrink text-ink-2", running && "text-ink")}>{title}</Text>
          {open ? null : <ChevronRight size={12} className="text-ink-4" />}
        </TranscriptPressable>
      ) : null}
      {shown ? <StepBody phase={phase} objects={objects} lines={lines} running={running} runId={runId} /> : null}
      {counts ? <Text className="pb-1 text-xs text-ink-4">{counts}</Text> : null}
      {wait ? <LiveLine headline={wait} /> : null}
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

/** The turn's work as writing: with a plan, "Step k of n" over its track; then each step and what it did, a line each. */
function Steps({ entries, headline, live, runId, turn }: { entries: WorkEntry[]; headline: LiveHeadline | null; live: boolean; runId: string; turn: Block[] }) {
  return (
    <View className="gap-1">
      <StepsHead entries={entries} />
      <View>
        {entries.map((entry) => {
          if (entry.kind === "phase") {
            const current = headline?.entryId === entry.phase.id ? headline : null;
            // Only the live step reads the rest of the turn (a test run's earlier count), so finished steps hold still while it streams.
            return <Step key={entry.phase.id} phase={entry.phase} headline={current} runId={runId} live={live} turn={current ? turn : undefined} />;
          }
          if (entry.kind === "plan") return <Plan key={entry.id} items={entry.items} live={live} />;
          return <Blocks key={entry.id} blocks={entry.blocks} runId={runId} />;
        })}
        {headline && !headline.entryId ? <LiveLine headline={headline} /> : null}
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
  const steps = useMemo(
    () => workEntries(row.work.filter((block) => block.kind !== "tool" || !block.subagent)).length + row.work.filter((block) => block.kind === "tool" && block.subagent).length,
    [row.work],
  );
  const receipt = useMemo(() => receiptItems(row.work, steps, row.live), [row.work, steps, row.live]);
  const [open, setOpen] = useOpen(`work:${row.turnId}`, row.live);
  // A press inside the open work records the reader's choice, so the card stays open when the turn ends.
  const keepOpen = useCallback(() => setOpen(true), [setOpen]);
  const now = row.now && row.now !== "reply" ? [row.now] : [];
  const headline = row.live && row.now !== "reply" ? liveHeadline(entries, now) : null;
  // Nothing done yet to sum up, as while a turn's only step still runs: the step shows, under no empty summary line.
  if (row.live && !receipt.length)
    return (
      <View className="py-3.5">
        <WorkChoice.Provider value={keepOpen}>
          <Steps entries={entries} headline={headline} live={row.live} runId={row.runId} turn={row.work} />
        </WorkChoice.Provider>
      </View>
    );
  return (
    <View>
      <TranscriptPressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={receipt.map((item) => item.label).join(", ") || "Work"}
        onPress={() => setOpen(!open)}
        className="-mx-2 min-h-touch flex-row flex-wrap items-center gap-x-4 gap-y-1 self-start px-2 py-3.5 active:opacity-60"
      >
        {receipt.map((item) => {
          const Icon = receiptIcon(item);
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
      </TranscriptPressable>
      {/* The row keeps the space under what it shows, as the receipt alone does under its line (see rows.ts). */}
      {open || headline ? (
        <View className="pb-3.5">
          {!open && headline ? (
            <View accessibilityRole="text" className="min-h-control-md flex-row items-center gap-2">
              <Spinner />
              <LiveWords headline={headline} elapsed />
            </View>
          ) : null}
          {open ? (
            <WorkChoice.Provider value={keepOpen}>
              <Steps entries={entries} headline={headline} live={row.live} runId={row.runId} turn={row.work} />
            </WorkChoice.Provider>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});
