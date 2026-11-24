import {
  fieldLabel,
  foldsWords,
  memoryAge,
  memoryKind,
  noticeFrom,
  oneLine,
  relativeTime,
  taskState,
  type MemoryRow,
  type NoticeFrom,
  type OwnToolView,
  type TaskRow,
  type ThreadRow,
} from "@openorc/client";
import { router } from "expo-router";
import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Globe } from "../generated/icons";
import { cn } from "../ui/cn";
import { useColors } from "../ui/mode";
import { Mono } from "../ui/Mono";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { Text } from "../ui/Text";
import { openInApp } from "../ui/web";
import { Markdown } from "./Markdown";
import { More, Quiet } from "./sheet-parts";
import { TranscriptPressable } from "./TranscriptPressable";

/** Rows a list shows before the rest wait behind a count. */
const ROWS = 6;
const THREADS = ["thread", "threads"] as const;
const MEMORIES = ["memory", "memories"] as const;
const TASKS = ["task", "tasks"] as const;

/**
 * One of OpenOrc's own tools, drawn as the thing it was about: threads as thread rows, a thread that was read as its
 * conversation, a message as what it said and where it landed, a page as its title with its picture, tasks and
 * memories as rows. `images`: the pictures the call gave back, for the views that show them.
 */
export function OwnView({ view, images }: { view: OwnToolView; images: ReactNode }) {
  switch (view.kind) {
    case "threads":
      return (
        <Rows items={view.threads} noun={THREADS} empty="No other threads">
          {(thread) => <ThreadLine key={thread.id} thread={thread} />}
        </Rows>
      );
    case "thread":
      return <Talk messages={view.messages} />;
    case "sent":
      return (
        <View className="gap-2">
          <Bubble text={view.text} written />
          {view.landed ? <Quiet bad={!view.delivered}>{view.landed}</Quiet> : null}
        </View>
      );
    case "page":
      return (
        <View className="gap-3">
          <TranscriptPressable accessibilityRole="link" onPress={() => openInApp(view.url)} className="min-h-touch flex-row items-center gap-2 active:opacity-60">
            <Globe size={16} className="text-ink-4" />
            <View className="min-w-0 flex-1">
              {view.title ? <Text numberOfLines={1}>{view.title}</Text> : null}
              <Text numberOfLines={1} className={view.title ? "text-xs text-ink-4" : "text-ink-2"}>
                {view.url.replace(/^https?:\/\//, "")}
              </Text>
            </View>
          </TranscriptPressable>
          {images}
          {view.text ? <Words text={view.text} plain /> : null}
        </View>
      );
    case "memories":
      return (
        <Rows items={view.hits} noun={MEMORIES} empty="Nothing in memory about this">
          {(hit, index) => <MemoryLine key={index} hit={hit} />}
        </Rows>
      );
    case "remembered":
      return (
        <View className="gap-2">
          <Text selectable className="text-ink-2">
            {view.body}
          </Text>
          {memoryKind(view.type) ? <Quiet>Kept as {memoryKind(view.type)}</Quiet> : null}
        </View>
      );
    case "tasks":
      return (
        <Rows items={view.tasks} noun={TASKS} empty="No tasks">
          {(task) => <TaskLine key={task.id} task={task} />}
        </Rows>
      );
    case "task":
      return <TaskLine task={view.task} />;
  }
}

/** A list as rows: the first few, then the rest behind a count. */
function Rows<T>({ items, noun, empty, children }: { items: T[]; noun: readonly [one: string, many: string]; empty: string; children: (item: T, index: number) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <Quiet>{empty}</Quiet>;
  const shown = all ? items : items.slice(0, ROWS);
  const rest = items.length - shown.length;
  return (
    <View>
      {shown.map(children)}
      {rest > 0 ? (
        // Under the names, past the marks.
        <View className="pl-6.5">
          <More label={`${rest} more ${noun[rest === 1 ? 0 : 1]}`} onPress={() => setAll(true)} />
        </View>
      ) : null}
    </View>
  );
}

/** Whether the thing is at work: the mark turning, or a hollow dot at rest. */
function Standing({ working }: { working: boolean }) {
  const palette = useColors();
  return (
    <View className="h-5 w-4 items-center justify-center">
      {working ? <OpenOrcMark size={14} color={palette["content-ink"]} working /> : <View className="size-2 rounded-full border-ink-4" style={{ borderWidth: StyleSheet.hairlineWidth * 2 }} />}
    </View>
  );
}

/**
 * A row of a list: its standing, a name in ink with a quiet word after it, what the row ends on, and one line of
 * what was last said under them.
 */
function Row({
  working,
  name,
  note,
  end,
  last,
  label,
  onPress,
}: {
  working: boolean | null;
  name: string;
  note: string | null;
  end: string;
  last: string | null;
  label?: string;
  onPress?: () => void;
}) {
  const row = (
    <>
      {working === null ? null : <Standing working={working} />}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="min-w-0 shrink">
            {name}
          </Text>
          {note ? (
            <Text numberOfLines={1} className="shrink-0 text-xs text-ink-4">
              {note}
            </Text>
          ) : null}
          {end ? <Text className="ml-auto shrink-0 text-xs text-ink-4 tabular-nums">{end}</Text> : null}
        </View>
        {last ? (
          <Text numberOfLines={2} className="text-xs text-ink-3">
            {last}
          </Text>
        ) : null}
      </View>
    </>
  );
  if (!onPress) return <View className={ROW}>{row}</View>;
  return (
    <TranscriptPressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className={cn(ROW, "active:bg-surface-2")}>
      {row}
    </TranscriptPressable>
  );
}

const ROW = "-mx-2 flex-row gap-2.5 rounded-xl px-2 py-2.5";

/** What a thread's row ends on: that it waits, or how long ago it last moved. */
function moved(thread: ThreadRow): string {
  if (thread.activity === "waiting") return "Waiting";
  return thread.lastActivityAt === null ? "" : relativeTime(thread.lastActivityAt);
}

/** A thread as the list of threads would show it, with the last thing its agent said. Pressing it opens the thread. */
function ThreadLine({ thread }: { thread: ThreadRow }) {
  return (
    <Row
      working={thread.activity !== "idle"}
      name={thread.title}
      note={thread.current ? "this thread" : thread.branch}
      end={moved(thread)}
      last={thread.lastReply ? oneLine(thread.lastReply) : null}
      label={`Open thread ${thread.title}`}
      // The thread the call was made from is the one already open under the sheet.
      onPress={thread.current ? undefined : () => router.replace({ pathname: "/thread/[id]", params: { id: thread.id } })}
    />
  );
}

/** A task as its board would show it: where it stands, and the newest thing said of it. Pressing it opens the task. */
function TaskLine({ task }: { task: TaskRow }) {
  return (
    <Row
      working={task.state === "working"}
      name={task.title}
      note={task.current ? "this task" : fieldLabel(task.status).toLowerCase()}
      end={taskState(task.state)}
      last={task.latest ? oneLine(task.latest) : null}
      label={`Open task ${task.title}`}
      onPress={() => router.replace({ pathname: "/task/[id]", params: { id: task.id } })}
    />
  );
}

function MemoryLine({ hit }: { hit: MemoryRow }) {
  return <Row working={null} name={hit.title} note={memoryKind(hit.type)?.replace(/^an? /, "") ?? null} end={memoryAge(hit.ageDays)} last={hit.summary || null} />;
}

/** A message as its bubble in a thread. `written`: an agent wrote it, so its marks are read; a person's words show as typed. */
function Bubble({ text, written = false }: { text: string; written?: boolean }) {
  return (
    <View className="max-w-5/6 self-end rounded-2xl bg-bubble px-4 py-3">
      <Words text={text} plain={!written} tone="text-bubble-ink" />
    </View>
  );
}

/** A thread's messages as a small conversation: the agent's words as prose, a person's as a bubble, a note from another thread behind a hairline. */
function Talk({ messages }: { messages: { role: string; text: string }[] }) {
  if (!messages.length) return <Quiet>No messages yet</Quiet>;
  return (
    <View className="gap-4">
      {messages.map((message, index) => (
        <Said key={index} role={message.role} text={message.text} />
      ))}
    </View>
  );
}

function Said({ role, text }: { role: string; text: string }) {
  if (role === "user") return <Bubble text={text} />;
  if (role !== "system") return <Words text={text} />;
  const from = noticeFrom(text);
  return (
    <View className="border-line pl-3" style={{ borderLeftWidth: 1.5 }}>
      {from ? <Sender from={from} /> : null}
      <Words text={from?.text ?? text} plain tone="text-ink-3" />
    </View>
  );
}

/** Who a note in a thread is from; a thread's name opens it. */
function Sender({ from }: { from: NoticeFrom }) {
  const words = (
    <Text className="text-xs text-ink-2">
      {from.lead} {from.name}
    </Text>
  );
  const { threadId } = from;
  if (!threadId) return words;
  return (
    <TranscriptPressable accessibilityRole="button" onPress={() => router.replace({ pathname: "/thread/[id]", params: { id: threadId } })} className="self-start active:opacity-60">
      {words}
    </TranscriptPressable>
  );
}

/** Words that read in full when short, and by their first lines until asked for when long. `plain`: not the agent's own writing, so shown as written. */
function Words({ text, plain = false, tone = "text-ink-2" }: { text: string; plain?: boolean; tone?: string }) {
  const [all, setAll] = useState(false);
  if (foldsWords(text) && !all)
    return (
      <View>
        <Text numberOfLines={3} className={tone}>
          {oneLine(text)}
        </Text>
        <More label="Show all" onPress={() => setAll(true)} />
      </View>
    );
  if (plain)
    return (
      <Text prose selectable className={tone}>
        {text}
      </Text>
    );
  return <Markdown text={text} streaming={false} tone="note" />;
}

/** How far in the outline goes before a value is shown as written, and how many of a list show before the rest wait. */
const DEPTH = 3;
const ITEMS = 5;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
const isPlain = (value: unknown) => typeof value !== "object" || value === null;

/** One value in words: yes or no, a link for an address, long words folded to their start, anything else as it is. */
function Plain({ value }: { value: unknown }) {
  if (typeof value === "boolean") return <Text className="text-ink-2">{value ? "Yes" : "No"}</Text>;
  if (typeof value !== "string") return <Text className="text-ink-2">{String(value)}</Text>;
  if (/^https?:\/\/\S+$/.test(value))
    return (
      <Text accessibilityRole="link" onPress={() => openInApp(value)} className="text-ink-2 underline">
        {value}
      </Text>
    );
  return <Words text={value} plain />;
}

/**
 * What a call gave back as data, read as an outline: each name in words, each value as itself, a list as its items.
 * Past a few levels a value is shown as written.
 */
export function Outline({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth >= DEPTH && !isPlain(value)) return <Mono text={JSON.stringify(value, null, 2)} />;
  if (Array.isArray(value)) return <OutlineList items={value} depth={depth} />;
  if (!isRecord(value)) return <Plain value={value} />;
  return (
    <View className="gap-2.5">
      {Object.entries(value)
        .filter(([, each]) => !isEmpty(each))
        .map(([key, each]) => (
          <View key={key} className="gap-0.5">
            <Quiet>{fieldLabel(key)}</Quiet>
            <Outline value={each} depth={depth + 1} />
          </View>
        ))}
    </View>
  );
}

/** A list: plain values in a line, things as items under one another, the first few until the rest are asked for. */
function OutlineList({ items, depth }: { items: unknown[]; depth: number }) {
  const [all, setAll] = useState(false);
  if (items.every(isPlain)) return <Text className="text-ink-2">{items.map(String).join(", ")}</Text>;
  const shown = all ? items : items.slice(0, ITEMS);
  return (
    <View className="gap-3">
      {shown.map((item, index) => (
        <View key={index} className="border-line pl-3" style={{ borderLeftWidth: 1.5 }}>
          <Outline value={item} depth={depth + 1} />
        </View>
      ))}
      {items.length > shown.length ? <More label={`Show all ${items.length}`} onPress={() => setAll(true)} /> : null}
    </View>
  );
}
