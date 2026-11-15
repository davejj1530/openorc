import type { BoardTask, Project, TaskStatus } from "@openorc/protocol";
import { ScrollView, View } from "react-native";
import Animated, { LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRpc } from "../client";
import { ChevronDown } from "../generated/icons";
import { motion } from "../generated/tokens";
import { MARGIN, ROW_INSET } from "../home/grid";
import { cn } from "../ui/cn";
import { ListPressable } from "../ui/ListPressable";
import { ease, turn } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { Text } from "../ui/Text";
import { boardGroup, boardGroups, copiedMeta, type BoardSection } from "./board";
import { TaskRow } from "./TaskRow";
import { useTaskBoard } from "./use-task-board";
import { useTaskFolds, type TaskFold } from "./use-task-folds";

/** Where labels start inside a row's inset, as Home's headings. */
const LABEL_PAD = MARGIN - ROW_INSET;
/** Groups under a fold slide to their new places, as Home's rows do. */
const slide = LinearTransition.duration(motion.duration.resize).easing(ease.outTiming);

/** The room above a heading: none under a folded group, so a run of them stacks tight, as Home's folded days do. */
type Room = "first" | "after-rows" | "after-heading";
const rooms: Record<Room, string> = { first: "mt-1", "after-rows": "mt-3", "after-heading": "" };

/** A status group's heading, as Home's parts fold: its name and count where titles start, the chevron in the action column. */
function GroupHeading({ status, count, fold, room }: { status: TaskStatus; count: number; fold: TaskFold; room: Room }) {
  const still = useReducedMotion();
  return (
    <ListPressable
      accessibilityRole="button"
      accessibilityState={{ expanded: fold.open }}
      accessibilityLabel={`${boardGroup[status]}, ${count}`}
      onPress={fold.toggle}
      className={cn("mx-3 min-h-touch flex-row items-center gap-1.5 rounded-lg pr-5 active:bg-surface-2", rooms[room])}
      style={{ paddingLeft: LABEL_PAD }}
    >
      <Text className="text-detail text-ink-4">{boardGroup[status]}</Text>
      <Text className="flex-1 text-detail text-ink-4 tabular-nums">{count}</Text>
      <Animated.View style={turn(fold.open, still)}>
        <ChevronDown size={16} className="text-ink-4" />
      </Animated.View>
    </ListPressable>
  );
}

/** The Mac's name over its groups with how old its list is, said only while the Mac is out of reach and the list is its last. */
function CopyHeading({ title, copiedAt, now }: { title: string; copiedAt: number; now: number }) {
  const meta = copiedMeta(copiedAt, now);
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={`${title}, ${meta}`} className="mx-3 mb-1 mt-2" style={{ paddingLeft: LABEL_PAD }}>
      <Text className="text-xl text-ink">{title}</Text>
      <Text className="text-detail text-ink-4">{meta}</Text>
    </View>
  );
}

function Group({
  section,
  status,
  tasks,
  fold,
  room,
  project,
}: {
  section: BoardSection;
  status: TaskStatus;
  tasks: BoardTask[];
  fold: TaskFold;
  room: Room;
  project: (id: string) => string | undefined;
}) {
  const still = useReducedMotion();
  return (
    <Animated.View layout={still ? undefined : slide}>
      <GroupHeading status={status} count={tasks.length} fold={fold} room={room} />
      {fold.shown
        ? tasks.map((task, at) => (
            <Animated.View key={task.id} style={fold.rowStyle(at)}>
              <TaskRow task={task} section={section} project={project(task.projectId)} />
            </Animated.View>
          ))
        : null}
    </Animated.View>
  );
}

/** The Mac's tasks by status, in the desktop's group order; each group folds. */
function Section({ section, now, folds }: { section: BoardSection; now: number; folds: (key: string) => TaskFold }) {
  const projects = useRpc("projects.list", {});
  const project = (id: string) => projects.data?.find((each: Project) => each.id === id)?.name;
  const headed = section.copiedAt !== null;
  const groups = boardGroups(section.tasks).map((group) => ({ ...group, fold: folds(`${section.key}:${group.status}`) }));
  return (
    <View>
      {section.copiedAt === null ? null : <CopyHeading title={section.title} copiedAt={section.copiedAt} now={now} />}
      {groups.map((group, index) => {
        let room: Room = index === 0 && !headed ? "first" : "after-rows";
        if (index === 0 && headed) room = "after-heading";
        else if (index > 0 && !groups[index - 1]!.fold.shown) room = "after-heading";
        return <Group key={group.status} section={section} status={group.status} tasks={group.tasks} fold={group.fold} room={room} project={project} />;
      })}
    </View>
  );
}

/**
 * Home's Tasks tab, as the desktop's task list reads at touch size: the shown Mac's open tasks, or its last list while
 * it is out of reach, grouped by status, each row with its status mark, title, project, age and priority, under Home's
 * bar and clear of its floating tabs.
 */
export function TaskList({ top, bottom }: { top: number; bottom: number }) {
  const insets = useSafeAreaInsets();
  const { section } = useTaskBoard();
  const folds = useTaskFolds();
  return (
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + top, paddingBottom: insets.bottom + bottom }} accessibilityLabel="Tasks">
      {section?.tasks.length ? (
        <Section section={section} now={Date.now()} folds={folds} />
      ) : (
        <View className="items-center gap-1 px-8 pt-24">
          <Text className="text-lg text-ink-2">No open tasks</Text>
          <Text className="text-center text-detail text-ink-4">Tasks you or your agents save on your Mac show here.</Text>
        </View>
      )}
    </ScrollView>
  );
}
