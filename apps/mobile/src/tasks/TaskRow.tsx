import { relativeTime } from "@openorc/client";
import type { BoardTask } from "@openorc/protocol";
import * as Clipboard from "expo-clipboard";
import { Link, router } from "expo-router";
import { useState, type ReactElement } from "react";
import { View } from "react-native";
import { ACTION_INSET, ACTION_RESERVE, MARGIN, ROW_INSET } from "../home/grid";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import { boardPriority, boardStatus, MAC_NEEDED, taskThread, type BoardSection } from "./board";
import { PriorityMark, TaskStatusMark } from "./TaskMarks";

/** On Home's grid: the status in the lead column, the title where titles start, the priority in the action column. */
const rowClass = "mx-3 flex-row gap-3 rounded-lg py-2 active:bg-surface-2";
const rowStyle = { paddingLeft: MARGIN - ROW_INSET, paddingRight: ACTION_RESERVE };
/** How far the priority's 28 pt box reaches past the row's end, so it centers on the action column, as a thread row's mark does. */
const MARK_PULL = ACTION_INSET - ROW_INSET - 14 - ACTION_RESERVE;

/** A row's status, priority when it has one, project and when it last changed: for VoiceOver and its menu. */
function taskFacts(task: BoardTask, project: string | undefined): string[] {
  return [boardStatus[task.status], task.priority === "none" ? null : boardPriority[task.priority], project, relativeTime(task.updatedAt)].filter((fact): fact is string => Boolean(fact));
}

/** The status mark, the title over its project and age, and the priority; `note` stays clear of a dimmed row's fade. */
function TaskLines({ task, project, dim = false, note = null }: { task: BoardTask; project: string | undefined; dim?: boolean; note?: string | null }) {
  const fade = dim ? "opacity-60" : undefined;
  return (
    <>
      <View className={cn("h-6 w-7 items-center justify-center", fade)}>
        <TaskStatusMark status={task.status} />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className={cn("gap-1", fade)}>
          <Text numberOfLines={1} className="text-xl text-ink">
            {task.title}
          </Text>
          <Text numberOfLines={1} className="text-detail text-ink-4">
            {[project, relativeTime(task.updatedAt)].filter(Boolean).join(" · ")}
          </Text>
        </View>
        {note ? <Text className="text-detail text-ink-3">{note}</Text> : null}
      </View>
      <View className={cn("h-6 w-7 items-center justify-center", fade)} style={{ marginRight: MARK_PULL }}>
        <PriorityMark priority={task.priority} />
      </View>
    </>
  );
}

/** A row's long-press menu: its conversation, when it has one, and its title to paste elsewhere. */
function taskMenu(task: BoardTask, host: string | null, facts: string[]): ReactElement {
  const thread = taskThread(task);
  const items = [
    ...(thread
      ? [
          <Link.MenuAction key="thread" icon="bubble.left" onPress={() => router.push({ pathname: "/thread/[id]", params: host ? { id: thread, host } : { id: thread } })}>
            Open Thread
          </Link.MenuAction>,
        ]
      : []),
    <Link.MenuAction key="copy" icon="doc.on.doc" onPress={() => void Clipboard.setStringAsync(task.title)}>
      Copy Title
    </Link.MenuAction>,
  ];
  return (
    <Link.Menu title={task.title} subtitle={facts.join(" · ")}>
      {items}
    </Link.Menu>
  );
}

/**
 * A task's row: it opens the task on its host, which leads on to its conversation; holding it opens its menu. A row
 * from the brain's copy of the Mac's list is read-only and dimmed: a press says the Mac is needed.
 */
export function TaskRow({ task, section, project }: { task: BoardTask; section: BoardSection; project: string | undefined }) {
  const [explained, setExplained] = useState(false);
  const facts = taskFacts(task, project);
  const label = [task.title, ...facts].join(", ");
  if (section.copy)
    return (
      <ListPressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setExplained((shown) => !shown)} className={rowClass} style={rowStyle}>
        <TaskLines task={task} project={project} dim note={explained ? MAC_NEEDED : null} />
      </ListPressable>
    );
  const thread = taskThread(task);
  const params = { id: task.id, ...(section.host ? { host: section.host } : {}), ...(thread ? { thread } : {}) };
  return (
    <Link href={{ pathname: "/task/[id]", params }} push asChild>
      <Link.Trigger>
        <ListPressable accessibilityRole="button" accessibilityLabel={label} className={rowClass} style={rowStyle}>
          <TaskLines task={task} project={project} />
        </ListPressable>
      </Link.Trigger>
      {taskMenu(task, section.host, facts)}
    </Link>
  );
}
