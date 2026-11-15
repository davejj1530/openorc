import { taskReferenceFromTool, type Block, type TaskToolSource } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpc } from "../../lib/client";
import { taskCardSource } from "../../lib/task-card-source";
import { useHostedFileScope } from "../../lib/hosted-file-scope";
import { useHostedConversation } from "../HostedConversationBoundary";
import { TaskCard } from "../TaskCard";
import { OnlineTaskCard } from "./TaskCard";

/**
 * A task tool's result as its task's card: this Mac's task in a Mac thread, as before, and the server's task in a cloud
 * thread or wherever the result names it. A server task is never looked up on this Mac.
 */
export function TaskToolCard({ block, taskId }: { block: Extract<Block, { kind: "tool" }>; taskId: string }) {
  const thread = useHostedConversation();
  const tool = taskReferenceFromTool(block, taskId);
  if (!thread && tool.kind === "none") return <TaskCard taskId={taskId} />;
  return <ServerTaskToolCard thread={thread} tool={tool} taskId={taskId} />;
}

function ServerTaskToolCard({ thread, tool, taskId }: { thread: ThreadSummary | null; tool: TaskToolSource; taskId: string }) {
  const scope = useHostedFileScope({ projectId: thread?.projectId ?? "", ...(thread && { threadId: thread.id }), enabled: Boolean(thread) });
  const status = useRpc("spaces.status", {}, {});
  const source = taskCardSource(taskId, tool, Boolean(thread), scope, status.data);
  if (source.kind === "online") return <OnlineTaskCard reference={source.reference} />;
  return <div className="my-2 text-sm text-ink-3">{status.isLoading ? "Loading task…" : "This task isn’t available here."}</div>;
}
