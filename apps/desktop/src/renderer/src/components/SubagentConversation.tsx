import type { Project, ThreadSummary } from "@openorc/protocol";
import { subagentStatusLabel, useTicking, workDuration } from "@openorc/client";
import { useConversationTranscript, useRpc, useRpcMutation } from "../lib/client";
import { openThread, useRouter } from "../lib/router";
import { Transcript } from "./Transcript";
import { Button } from "./ui";
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

export function SubagentParent({ id }: { id: string | null | undefined }) {
  const parent = useRpc("threads.get", { id: id ?? "" }, { enabled: Boolean(id) });
  if (!id) return null;
  return (
    <button className="subagent-parent no-drag" onClick={() => openThread(id)} title={parent.data?.title}>
      {" "}
      {parent.data?.title ?? "Parent"}
      <span aria-hidden> / </span>
    </button>
  );
}
