import type { Project, ThreadSummary } from "@openorc/protocol";
import { subagentStatusLabel, useTicking, workDuration } from "@openorc/client";
import { useConversationTranscript, useRpc, useRpcMutation } from "../lib/client";
import { openThread, useRouter } from "../lib/router";
import { Transcript } from "./Transcript";
import { CornerUpLeft } from "./icons";
import { Button, Tooltip } from "./ui";
import { ConversationVoice, useRunVoices } from "../lib/turn-authors";
import { subagentLinkFolder } from "../lib/conversation-status-presentation";

export function SubagentConversation({ thread, project }: { thread: ThreadSummary; project: Project }) {
  const history = useRpc("runs.listForThread", { threadId: thread.id });
  const target = useRouter(({ route }) => (route.view === "thread" && route.threadId === thread.id ? route.message : undefined));
  const { merged, hasOlder, loadOlder } = useConversationTranscript({ runs: history.data ?? [], threadId: thread.id, target });
  const voice = useRunVoices({ authors: new Map() }, history.data ?? [], thread);
  const parent = useRpc("threads.get", { id: thread.parentThreadId ?? "" }, { enabled: thread.owner?.brain === "cloud" && Boolean(thread.parentThreadId) });
  const links = subagentLinkFolder(thread, parent.data, project);
  return (
    <ConversationVoice.Provider value={voice}>
      <div className="h-full min-w-0 flex flex-col min-h-0">
        <div className="flex-1 min-h-0">
          {merged ? (
            <Transcript
              run={merged}
              scrollKey={thread.id}
              media={links ? { basePath: links } : { fileLinks: "cite" }}
              working={thread.subagent?.status === "running"}
              hasOlder={hasOlder}
              onLoadOlder={loadOlder}
              reveal={target}
            />
          ) : null}
          {history.error ? <Button onClick={() => void history.refetch()}>Retry loading history</Button> : null}
        </div>
        <SubagentStatusBar thread={thread} model={voice.agent?.model ?? thread.model} />
      </div>
    </ConversationVoice.Provider>
  );
}

function SubagentStatusBar({ thread, model }: { thread: ThreadSummary; model: string | null }) {
  const stop = useRpcMutation("subagents.stop");
  const child = thread.subagent;
  const now = useTicking(child?.status === "running");
  return (
    <div className="subagent-status-bar">
      <div className="subagent-status-inner">
        <span className="truncate">
          {model}
          {thread.effort ? <span className="text-ink-3"> · {thread.effort}</span> : null}
        </span>
        {child ? (
          <span className="text-ink-3 tabular">
            {subagentStatusLabel[child.status]} · {workDuration((child.endedAt ?? now) - child.startedAt)}
          </span>
        ) : null}
        {child?.stoppable ? (
          <Button size="sm" disabled={stop.isPending} onClick={() => stop.mutate({ threadId: thread.id })}>
            {stop.isPending ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      {stop.error ? (
        <p role="alert" className="text-xs text-bad">
          {stop.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** The thread a sub thread sits under, ahead of its title in the header. */
export function ThreadParent({ id, fact = false }: { id: string | null | undefined; fact?: boolean }) {
  const parent = useRpc("threads.get", { id: id ?? "" }, { enabled: Boolean(id) });
  if (!id) return null;
  const title = parent.data?.title ?? "Parent";
  // Among the header's facts it stands alone, not before a title: a mark and the name, cut short with an ellipsis.
  if (fact)
    return (
      <Tooltip label={`Started from ${title}`}>
        <button type="button" className="thread-header-fact thread-header-fact-link thread-parent-fact no-drag" onClick={() => openThread(id)}>
          <CornerUpLeft size={12} />
          <span className="truncate">{title}</span>
        </button>
      </Tooltip>
    );
  return (
    <button className="subagent-parent no-drag" onClick={() => openThread(id)} data-tip={parent.data?.title}>
      {" "}
      {parent.data?.title ?? "Parent"}
      <span aria-hidden> / </span>
    </button>
  );
}
