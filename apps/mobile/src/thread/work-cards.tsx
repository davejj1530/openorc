import { startedWorkFromTool, taskIdFromTool, type Block } from "@openorc/client";
import type { ThreadActivity } from "@openorc/protocol";
import { router } from "expo-router";
import { useContext, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useRpc } from "../client";
import { HostContext } from "../connection/host-context";
import { ArrowUpRight, ListTodo, MessageSquare } from "../generated/icons";
import { boardStatus } from "../tasks/board";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { ToolRow } from "./tools";

type ToolBlock = Extract<Block, { kind: "tool" }>;

const activityLabel: Record<ThreadActivity, string> = { running: "Working", waiting: "Needs you", idle: "Idle" };

/** One r24 plane row for work a tool call saved or started: what it is, where it stands, and a tap opens it. */
function WorkCard({ icon, title, line, waiting, onPress }: { icon: ReactNode; title: string; line: string; waiting: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${line}`}
      onPress={onPress}
      className="min-h-touch-row flex-row items-center gap-3 rounded-3xl bg-surface px-4 py-3 active:bg-surface-2"
    >
      {icon}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={2} className="text-lg">
          {title}
        </Text>
        <Text numberOfLines={1} className={cn("text-detail text-ink-4", waiting && "text-attention")}>
          {line}
        </Text>
      </View>
      <ArrowUpRight size={16} className="text-ink-4" />
    </Pressable>
  );
}

/** A task the agent saved or started: its title and status, opening the task. A Mac that cannot open tasks keeps the call's row. */
function TaskCard({ taskId, block, runId }: { taskId: string; block: ToolBlock; runId: string }) {
  const host = useContext(HostContext);
  const task = useRpc("tasks.get", { id: taskId });
  if (!task.data) return task.isLoading ? <View className="h-16 rounded-3xl bg-surface" /> : <ToolRow block={block} runId={runId} />;
  const { title, status } = task.data;
  return (
    <WorkCard
      icon={<ListTodo size={18} className="text-ink-4" />}
      title={title}
      line={`Task · ${boardStatus[status]}`}
      waiting={false}
      onPress={() => router.push({ pathname: "/task/[id]", params: host ? { id: taskId, host } : { id: taskId } })}
    />
  );
}

/** A thread the agent started, as a subthread of this one: its title and what it is doing, opening it. */
function StartedThreadCard({ threadId, block, runId }: { threadId: string; block: ToolBlock; runId: string }) {
  const host = useContext(HostContext);
  const thread = useRpc("threads.get", { id: threadId });
  if (!thread.data) return thread.isLoading ? <View className="h-16 rounded-3xl bg-surface" /> : <ToolRow block={block} runId={runId} />;
  const { title, activity } = thread.data;
  return (
    <WorkCard
      icon={<MessageSquare size={18} className="text-ink-4" />}
      title={title}
      line={`Subthread · ${activityLabel[activity]}`}
      waiting={activity === "waiting"}
      onPress={() => router.push({ pathname: "/thread/[id]", params: host ? { id: threadId, host } : { id: threadId } })}
    />
  );
}

/** A tool call after a turn's work: the task or thread it made as a card that opens it, else the call's own row. */
export function ToolCard({ block, runId }: { block: ToolBlock; runId: string }) {
  const taskId = taskIdFromTool(block);
  if (taskId) return <TaskCard taskId={taskId} block={block} runId={runId} />;
  const started = startedWorkFromTool(block);
  if (started) return <StartedThreadCard threadId={started.threadId} block={block} runId={runId} />;
  return <ToolRow block={block} runId={runId} />;
}
