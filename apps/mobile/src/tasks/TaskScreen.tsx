import { relativeTime } from "@openorc/client";
import type { Task, TaskButton } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useRpc } from "../client";
import { useLinkWords } from "../connection/use-link-words";
import { GitBranch } from "../generated/icons";
import { Markdown } from "../thread/Markdown";
import { arrive } from "../ui/motion";
import { Measure } from "../ui/pane";
import { useReducedMotion } from "../ui/reduced-motion";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { holdsSecret, SECRET_SPEC, typedTitle, useTaskEdit, type SaveTask } from "./task-edit";
import { taskPlace, taskPlaces, type TaskPlace } from "./task-places";
import { TaskButtons } from "./TaskButtons";
import { TaskProperties } from "./TaskProperties";
import { openRefine, showsSuggestion, TaskRefine } from "./TaskRefine";
import { TaskThreads, ThreadLink } from "./TaskThreads";
import { useBoardColumns } from "./use-board-columns";
import { useTaskRefine, useTaskWork, type TaskRefineView } from "./use-task-refine";

const NO_BUTTONS: readonly TaskButton[] = [];

/**
 * The bar's title, as a thread's: the task's title over where it stands, once the title on the page has scrolled under
 * the bar, and the connection's state while the phone is not connected. Nothing otherwise: the page's title is it. The
 * frame stays the same size throughout, as the bar keeps the size its title first had.
 */
function TaskBarTitle({ task, place, project, shown }: { task: Task | null; place: string | null; project: string | null; shown: boolean }) {
  const link = useLinkWords(useLinkState());
  const still = useReducedMotion();
  const away = link.tone !== "ok" && link.status ? link.status : null;
  const title = shown && task ? task.title : null;
  const line = away ?? (title ? [place, project].filter(Boolean).join(" · ") : null);
  const words = [title, line].filter(Boolean).join(", ");
  return (
    <View className="h-9 w-60 items-center justify-center">
      {words ? (
        <Animated.View key={title ? "title" : "line"} accessible accessibilityRole="header" accessibilityLabel={words} className="max-w-full items-center" style={still ? undefined : arrive}>
          {title ? (
            <Text numberOfLines={1} className="text-md leading-5">
              {title}
            </Text>
          ) : null}
          {line ? (
            <Text numberOfLines={1} className="text-xs leading-4 text-ink-4">
              {line}
            </Text>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The title at the page's head, edited in place as the desktop's task document edits it: saved when it loses focus. */
function TitleField({ title, onSave, onLayout }: { title: string; onSave: (title: string) => void; onLayout: (bottom: number) => void }) {
  const [draft, setDraft] = useState(title);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(title);
  }, [title, editing]);
  const done = () => {
    setEditing(false);
    const next = typedTitle(title, draft);
    if (next) onSave(next);
    else setDraft(title);
  };
  return (
    <TextInput
      multiline
      scrollEnabled={false}
      value={draft}
      onChangeText={(typed) => setDraft(typed.replace(/\n/g, ""))}
      onFocus={() => setEditing(true)}
      onBlur={done}
      submitBehavior="blurAndSubmit"
      returnKeyType="done"
      maxLength={200}
      accessibilityLabel="Task title"
      onLayout={(event) => onLayout(event.nativeEvent.layout.y + event.nativeEvent.layout.height)}
      className="p-0 font-sans text-2xl text-ink"
    />
  );
}

/** When the task last changed, and the branch its work is on. */
function TaskFacts({ task }: { task: Task }) {
  return (
    <View className="gap-1.5">
      <Text className="text-detail text-ink-4">{`Updated ${relativeTime(task.updatedAt)}`}</Text>
      {task.branch ? (
        <View className="flex-row items-center gap-1.5">
          <GitBranch size={16} className="text-ink-4" />
          <Text numberOfLines={1} className="flex-1 font-mono text-detail text-ink-4">
            {task.branch}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The spec as the reply's prose, under a heading with Edit, which opens it as text; one that holds a secret stays the
 * Mac's to edit. With `onRefine`, Refine stands beside Edit.
 */
function Description({ task, onRefine }: { task: Task; onRefine: (() => void) | null }) {
  const spec = task.spec?.trim() ? task.spec : null;
  const secret = holdsSecret(spec);
  const edit = () => router.push({ pathname: "/task-description", params: { id: task.id } });
  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-detail text-ink-4">
          Description
        </Text>
        {secret ? null : (
          <View className="flex-row items-center gap-5">
            {onRefine ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Refine this task" onPress={onRefine} hitSlop={14} className="active:opacity-60">
                <Text className="text-detail text-ink-2">Refine</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" accessibilityLabel="Edit description" onPress={edit} hitSlop={14} className="active:opacity-60">
              <Text className="text-detail text-ink-2">Edit</Text>
            </Pressable>
          </View>
        )}
      </View>
      {secret ? <Text className="text-detail text-ink-4">{SECRET_SPEC}</Text> : null}
      {spec ? (
        <Markdown text={spec} streaming={false} />
      ) : (
        <Pressable accessibilityRole="button" onPress={edit} className="active:opacity-60">
          <Text className="text-lg text-ink-4">Add a description</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Whether the page's title has scrolled under the bar, from the title's bottom on the page. */
function useTitleUnder() {
  const [bottom, setBottom] = useState(Number.POSITIVE_INFINITY);
  const [under, setUnder] = useState(false);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => setUnder(event.nativeEvent.contentOffset.y > bottom);
  return { under, onScroll, setBottom };
}

interface PageProps {
  task: Task;
  project: string | null;
  /** The Status menu's entries: the board's columns for a project that keeps them, else the statuses. */
  places: readonly TaskPlace[];
  buttons: readonly TaskButton[];
  /** The Mac lists the task's threads, runs its buttons and refines it for a phone. */
  work: boolean;
  refine: TaskRefineView;
  onSave: SaveTask;
  onTitle: (bottom: number) => void;
}

function TaskPage({ task, project, places, buttons, work, refine, onSave, onTitle }: PageProps) {
  // One Refine at a time: while one runs or waits to be used, its own card offers what comes next.
  const offerRefine = work && !refine.refine ? () => openRefine(task.id) : null;
  return (
    <>
      <View className="gap-3">
        <TitleField title={task.title} onSave={(title) => onSave({ title })} onLayout={onTitle} />
        <TaskProperties task={task} project={project} places={places} onSave={onSave} />
        <TaskFacts task={task} />
      </View>
      {work ? <TaskButtons task={task} buttons={buttons} /> : null}
      <TaskThreads task={task} listed={work} />
      <TaskRefine task={task} view={refine} />
      {showsSuggestion(refine) ? null : <Description task={task} onRefine={offerRefine} />}
    </>
  );
}

/**
 * One task on the phone, as its document reads and edits on the Mac: the title, its properties, the project's buttons
 * for it, every conversation it has had, Refine, and its description. Its first start, its workspace and deleting it
 * stay on the Mac.
 */
export function TaskScreen() {
  // `thread` is the conversation to offer if the Mac cannot open the task itself, as one from before task details.
  const { id, thread } = useLocalSearchParams<{ id: string; thread?: string }>();
  const insets = useSafeAreaInsets();
  const task = useRpc("tasks.get", { id });
  const { shown, save } = useTaskEdit(task.data);
  const projects = useRpc("projects.list", {});
  const project = projects.data?.find((each) => each.id === shown?.projectId);
  const columns = useBoardColumns(shown?.projectId);
  const places = useMemo(() => taskPlaces(columns), [columns]);
  const work = useTaskWork();
  const refine = useTaskRefine(id, work && Boolean(shown));
  const title = useTitleUnder();
  return (
    <Measure className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => <TaskBarTitle task={shown} place={shown ? taskPlace(shown, places).name : null} project={project?.name ?? null} shown={title.under} /> }} />
      {shown ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={title.onScroll}
          scrollEventThrottle={32}
          contentContainerClassName="gap-6 px-5 pt-3"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <TaskPage
            task={shown}
            project={project?.name ?? null}
            places={places}
            buttons={project?.settings.taskButtons ?? NO_BUTTONS}
            work={work}
            refine={refine}
            onSave={save}
            onTitle={title.setBottom}
          />
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          {task.isLoading ? <WorkingMark /> : <Text className="text-center text-lg text-ink-3">{task.error?.message ?? "This task is no longer available."}</Text>}
          {!task.isLoading && thread ? (
            <View className="self-stretch">
              <ThreadLink threadId={thread} label="Its conversation" />
            </View>
          ) : null}
        </View>
      )}
    </Measure>
  );
}
