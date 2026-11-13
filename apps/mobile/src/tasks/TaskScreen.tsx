import { relativeTime } from "@openorc/client";
import type { Task } from "@openorc/protocol";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useContext, useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useRpc } from "../client";
import { HostContext } from "../connection/host-context";
import { useHeaderScope } from "../connection/HostScope";
import { useLinkWords } from "../connection/use-link-words";
import { ArrowUpRight, GitBranch, MessageSquare } from "../generated/icons";
import { Markdown } from "../thread/Markdown";
import { arrive } from "../ui/motion";
import { useReducedMotion } from "../ui/reduced-motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { boardStatus } from "./board";
import { holdsSecret, SECRET_SPEC, typedTitle, useTaskEdit, type TaskPatch } from "./task-edit";
import { TaskProperties } from "./TaskProperties";

/** A conversation the task belongs to, one tap away: the one doing its work, or the one it came from. */
function ThreadLink({ threadId, label }: { threadId: string; label: string }) {
  const host = useContext(HostContext);
  const thread = useRpc("threads.get", { id: threadId }).data;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}${thread ? `, ${thread.title}` : ""}`}
      onPress={() => router.push({ pathname: "/thread/[id]", params: host ? { id: threadId, host } : { id: threadId } })}
      className="min-h-touch-row flex-row items-center gap-3 rounded-3xl bg-surface px-4 py-3 active:bg-surface-2"
    >
      <MessageSquare size={18} className="text-ink-4" />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-detail text-ink-4">{label}</Text>
        <Text numberOfLines={2} className="text-lg">
          {thread?.title ?? "Conversation"}
        </Text>
      </View>
      <ArrowUpRight size={16} className="text-ink-4" />
    </Pressable>
  );
}

/**
 * The bar's title, as a thread's: the task's title over where it stands, once the title on the page has scrolled under
 * the bar, and the connection's state while the phone is not connected. Nothing otherwise: the page's title is it. The
 * frame stays the same size throughout, as the bar keeps the size its title first had.
 */
function TaskBarTitle({ task, project, shown }: { task: Task | null; project: string | null; shown: boolean }) {
  const link = useLinkWords(useLinkState());
  const still = useReducedMotion();
  const away = link.tone !== "ok" && link.status ? link.status : null;
  const title = shown && task ? task.title : null;
  const line = away ?? (title && task ? [boardStatus[task.status], project].filter(Boolean).join(" · ") : null);
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

/** The spec as the reply's prose, under a heading with Edit, which opens it as text; one that holds a secret stays the Mac's to edit. */
function Description({ task }: { task: Task }) {
  const host = useContext(HostContext);
  const spec = task.spec?.trim() ? task.spec : null;
  const secret = holdsSecret(spec);
  const edit = () => router.push({ pathname: "/task-description", params: host ? { id: task.id, host } : { id: task.id } });
  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-detail text-ink-4">
          Description
        </Text>
        {secret ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Edit description" onPress={edit} hitSlop={14} className="active:opacity-60">
            <Text className="text-detail text-ink-2">Edit</Text>
          </Pressable>
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

function TaskPage({ task, project, onSave, onTitle }: { task: Task; project: string | null; onSave: (patch: TaskPatch) => void; onTitle: (bottom: number) => void }) {
  const working = task.executionThreadId;
  const origin = task.threadId && task.threadId !== working ? task.threadId : null;
  return (
    <>
      <View className="gap-3">
        <TitleField title={task.title} onSave={(title) => onSave({ title })} onLayout={onTitle} />
        <TaskProperties task={task} project={project} onSave={onSave} />
        <TaskFacts task={task} />
      </View>
      {working || origin ? (
        <View className="gap-2">
          {working ? <ThreadLink threadId={working} label="Working in" /> : null}
          {origin ? <ThreadLink threadId={origin} label="Started from" /> : null}
        </View>
      ) : null}
      <Description task={task} />
    </>
  );
}

/**
 * One task on the phone, as its document reads and edits on the Mac: the title, its properties, the conversations it
 * belongs to, and its description. Starting it, its workspace and deleting it stay on the Mac.
 */
export function TaskScreen() {
  // `thread` is the conversation to offer if the Mac cannot open the task itself, as one from before task details.
  const { id, thread } = useLocalSearchParams<{ id: string; thread?: string }>();
  const insets = useSafeAreaInsets();
  const inScope = useHeaderScope();
  const task = useRpc("tasks.get", { id });
  const { shown, save } = useTaskEdit(task.data);
  const projects = useRpc("projects.list", {});
  const project = projects.data?.find((each) => each.id === shown?.projectId)?.name ?? null;
  const title = useTitleUnder();
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={{ headerTitle: () => inScope(<TaskBarTitle task={shown} project={project} shown={title.under} />) }} />
      {shown ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={title.onScroll}
          scrollEventThrottle={32}
          contentContainerClassName="gap-6 px-5 pt-3"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        >
          <TaskPage task={shown} project={project} onSave={save} onTitle={title.setBottom} />
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-8">
          {task.isLoading ? <Spinner /> : <Text className="text-center text-lg text-ink-3">{task.error?.message ?? "This task is no longer available."}</Text>}
          {!task.isLoading && thread ? (
            <View className="self-stretch">
              <ThreadLink threadId={thread} label="Its conversation" />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}
