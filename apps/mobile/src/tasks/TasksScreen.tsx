import type { BoardTask, Project } from "@openorc/protocol";
import { Link, Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useRpc } from "../client";
import { HostScope } from "../connection/HostScope";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { Text } from "../ui/Text";
import { boardStatus, CLOUD_ONLY, copiedMeta, MAC_NEEDED, taskThread, type BoardSection } from "./board";
import { useTaskBoard } from "./use-task-board";

function TaskLine({ task, project }: { task: BoardTask; project: string | undefined }) {
  return (
    <>
      <Text numberOfLines={1}>{task.title}</Text>
      <Text numberOfLines={1} className="text-sm text-ink-4">
        {[boardStatus[task.status], project].filter(Boolean).join(" · ")}
      </Text>
    </>
  );
}

const rowClass = "mx-2.5 min-h-touch-row justify-center gap-0.5 rounded-md px-2.5 py-1.5";

/**
 * A task's row: it opens its conversation on its host. A row from the brain's copy of the Mac's list is read-only: a
 * press says the Mac is needed. A task with no conversation yet only shows.
 */
function TaskRow({ task, section, project }: { task: BoardTask; section: BoardSection; project: string | undefined }) {
  const [explained, setExplained] = useState(false);
  const thread = taskThread(task);
  const label = [task.title, boardStatus[task.status], project].filter(Boolean).join(", ");
  if (section.copy)
    return (
      <ListPressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setExplained((shown) => !shown)} className={cn(rowClass, "active:bg-surface-2")}>
        <View className="gap-0.5 opacity-60">
          <TaskLine task={task} project={project} />
        </View>
        {explained ? <Text className="text-sm text-ink-3">{MAC_NEEDED}</Text> : null}
      </ListPressable>
    );
  if (!thread)
    return (
      <View accessible accessibilityLabel={label} className={rowClass}>
        <TaskLine task={task} project={project} />
      </View>
    );
  return (
    <Link href={{ pathname: "/thread/[id]", params: section.host ? { id: thread, host: section.host } : { id: thread } }} push asChild>
      <ListPressable accessibilityRole="button" accessibilityLabel={label} className={cn(rowClass, "active:bg-surface-2")}>
        <TaskLine task={task} project={project} />
      </ListPressable>
    </Link>
  );
}

/** One host's tasks, its projects named as that host has them. */
function Section({ section, now }: { section: BoardSection; now: number }) {
  const projects = useRpc("projects.list", {});
  const name = (id: string) => projects.data?.find((project: Project) => project.id === id)?.name;
  const meta = section.copy && copiedMeta(section.copy.at, now);
  return (
    <View className="mt-3">
      <View accessible accessibilityRole="header" accessibilityLabel={[section.title, meta].filter(Boolean).join(", ")} className="mx-2.5 min-h-touch flex-row items-center gap-1 pl-1.5 pr-3">
        <Text numberOfLines={1} className="flex-1 leading-4">
          {section.title}
        </Text>
        {meta ? <Text className="text-sm leading-4 text-ink-4">{meta}</Text> : null}
      </View>
      {section.copy?.cloudOnly ? <Text className="mx-2.5 mb-1 pl-1.5 text-sm text-ink-4">{CLOUD_ONLY}</Text> : null}
      {section.tasks.map((task) => (
        <TaskRow key={task.id} task={task} section={section} project={name(task.projectId)} />
      ))}
    </View>
  );
}

/** The open tasks of the shown host and its partner: the Mac's, its cloud brain's, and the brain's copy of the Mac's while it sleeps. */
export function TasksScreen() {
  const { sections } = useTaskBoard();
  const now = Date.now();
  const listed = sections.filter((section) => section.tasks.length);
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ title: "Tasks" }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="pb-6">
        {listed.length ? (
          listed.map((section) => (
            // A scope's reads keep the client they started on, so a copy that comes from another host starts again there.
            <HostScope key={`${section.key}:${section.namesOn ?? ""}`} host={section.namesOn}>
              <Section section={section} now={now} />
            </HostScope>
          ))
        ) : (
          <Text className="mx-5 mt-6 text-ink-3">No open tasks</Text>
        )}
      </ScrollView>
    </View>
  );
}
