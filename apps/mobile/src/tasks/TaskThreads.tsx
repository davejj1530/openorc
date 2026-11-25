import { relativeTime, taskThreadRole, threadActivity } from "@openorc/client";
import type { Task, TaskThreadLink } from "@openorc/protocol";
import { router } from "expo-router";
import { Children, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRpc } from "../client";
import { ArrowUpRight, MessageSquare } from "../generated/icons";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";

const open = (threadId: string) => router.push({ pathname: "/thread/[id]", params: { id: threadId } });

/** A conversation of the task as a row, one tap away: what it is to the task over its title, a cube while it works. */
function ThreadRow({ threadId, label, title, working = false }: { threadId: string; label: string; title: string; working?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${title}`}
      onPress={() => open(threadId)}
      className="min-h-touch-row flex-row items-center gap-3 px-4 py-2.5 active:bg-surface-2"
    >
      {working ? <WorkingMark /> : <MessageSquare size={18} className="text-ink-4" />}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="text-detail text-ink-4">
          {label}
        </Text>
        <Text numberOfLines={1} className="text-lg">
          {title}
        </Text>
      </View>
      <ArrowUpRight size={16} className="text-ink-4" />
    </Pressable>
  );
}

/** The task's conversations as one card, a hairline between its rows, inset to where their words start. */
function ThreadCard({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <View className="overflow-hidden rounded-3xl bg-surface">
      {rows.map((row, index) => (
        <View key={index}>
          {index ? <View className="ml-13 bg-line" style={{ height: StyleSheet.hairlineWidth }} /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/** A conversation the task belongs to, named once the Mac says what it is called. */
function NamedRow({ threadId, label }: { threadId: string; label: string }) {
  const thread = useRpc("threads.get", { id: threadId }).data;
  return <ThreadRow threadId={threadId} label={label} title={thread?.title ?? "Conversation"} />;
}

/** One conversation on its own card, as a task that cannot be opened offers its conversation. */
export function ThreadLink({ threadId, label }: { threadId: string; label: string }) {
  return (
    <ThreadCard>
      <NamedRow threadId={threadId} label={label} />
    </ThreadCard>
  );
}

/** What a thread is to the task, how it stands and when it last moved, as the Mac's task page says it. */
const linkLine = (link: TaskThreadLink): string =>
  [taskThreadRole(link), threadActivity(link.thread)?.text, relativeTime(link.thread.lastActivityAt ?? link.thread.updatedAt)].filter(Boolean).join(" · ");

/**
 * The conversations a task belongs to, on one card. Where the Mac lists them, every thread the task has had, its
 * current one first, then earlier work and the threads its buttons started; else the one doing its work. The one it
 * came from follows when it is not among them.
 */
export function TaskThreads({ task, listed }: { task: Task; listed: boolean }) {
  const links = useRpc("tasks.threads", { taskId: task.id }, { enabled: listed }).data;
  const working = task.executionThreadId;
  const among = (threadId: string) => (links ? links.some((link) => link.thread.id === threadId) : threadId === working);
  const origin = task.threadId && !among(task.threadId) ? task.threadId : null;
  if (!links?.length && !working && !origin) return null;
  return (
    <ThreadCard>
      {links?.map((link) => (
        <ThreadRow key={link.thread.id} threadId={link.thread.id} label={linkLine(link)} title={link.thread.title} working={link.thread.activity === "running"} />
      ))}
      {!links && working ? <NamedRow threadId={working} label="Working in" /> : null}
      {origin ? <NamedRow threadId={origin} label="Started from" /> : null}
    </ThreadCard>
  );
}
