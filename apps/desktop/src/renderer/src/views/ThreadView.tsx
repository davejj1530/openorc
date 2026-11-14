import { useSpaceThread, useUnavailableThread } from "../lib/space-queries";
import { isSubagentThread } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { Conversation } from "../components/Conversation";
import { ThreadHeader, ThreadHeaderPlaceholder } from "../components/ThreadHeader";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useRpc, useRpcMutation } from "../lib/client";
import { useConversationPlans } from "../lib/conversation-plans";
import { useLayout } from "../lib/layout";
import { useReadWhileShown } from "../lib/read-while-shown";
import { useRouter } from "../lib/router";
import { UnavailableThread } from "./UnavailableThread";

interface ThreadViewProps {
  threadId: string;
  first: boolean;
  last: boolean;
  focused: boolean;
  onClose?: () => void;
}

export function ThreadView(props: ThreadViewProps) {
  const unavailable = useUnavailableThread(props.threadId);
  return unavailable ? <UnavailableThread title={unavailable.title} first={props.first} last={props.last} onClose={props.onClose} /> : <AccessibleThread {...props} />;
}

/**
 * A stable, thread-scoped conversation. The workspace owns the shared panel.
 */
/** `first` and `last` say whether this pane's header starts or ends the work row, past any panel docked beside it. */
function AccessibleThread({ threadId, first, last, focused, onClose }: ThreadViewProps) {
  const thread = useSpaceThread(threadId);
  const project = useRpc("projects.get", { id: thread.data?.projectId ?? "" }, { enabled: Boolean(thread.data) });
  const update = useRpcMutation("threads.update");
  const followProject = useLayout((s) => s.followProject);
  const [renaming, setRenaming] = useState(false);
  const activate = () => {
    if (!focused) useRouter.getState().focusThreadPane(threadId);
  };
  const t = thread.data?.teamInstanceId ? null : thread.data;
  const p = project.data;

  // Opening a thread brings the sidebar's filter to its project, unless the filter shows every project. Only opening
  // it does: the thread's own updates leave a filter the user moved since where they put it.
  const threadProject = t?.projectId;
  useEffect(() => {
    if (threadProject && focused) followProject(threadProject);
  }, [threadId, threadProject, focused, followProject]);

  useReadWhileShown(t);

  useEffect(() => {
    if (thread.isSuccess && !thread.awaitingAccess && !t) useRouter.getState().closeThreadPane(threadId);
  }, [thread.isSuccess, thread.awaitingAccess, t, threadId]);

  if (thread.awaitingAccess) return <UnavailableThread title={thread.knownTitle ?? "Thread"} first={first} last={last} onClose={onClose} checking />;

  if (!t || !p) {
    return (
      <main className="workspace-main well flex-1 min-w-0 flex flex-col">
        <ThreadHeaderPlaceholder loading={thread.isLoading || project.isLoading} first={first} last={last} onClose={onClose} />
      </main>
    );
  }

  return (
    <ClaudeAccountScope id={t.claudeAccountId ?? "claude-cli"}>
      {!isSubagentThread(t) ? <RevealEmittedPlan key={threadId} threadId={threadId} focused={focused} /> : null}
      <main className="workspace-main well flex-1 min-w-0 flex flex-col">
        <ThreadHeader thread={t} renaming={renaming} onRenamingChange={setRenaming} onRename={(title) => update.mutate({ id: t.id, patch: { title } })} first={first} last={last} onClose={onClose} />
        {/* Header controls own their thread explicitly; only conversation interaction activates a pane. */}
        <div className="thread-pane-content flex-1 min-h-0" onPointerDownCapture={activate} onFocusCapture={activate}>
          <Conversation key={t.id} scope={{ kind: "thread", thread: t }} project={p} />
        </div>
      </main>
    </ClaudeAccountScope>
  );
}

/** Observe plan arrivals separately so streamed text doesn't rerender the conversation. */
function RevealEmittedPlan({ threadId, focused }: { threadId: string; focused: boolean }) {
  const { plans, isSuccess } = useConversationPlans(threadId);
  const latest = plans.find((plan) => plan.text.trim());
  const planId = latest?.id ?? null;
  const observed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isSuccess) return;
    // Loading saved history is not a new emission. Reopen it manually via Plan.
    if (observed.current === undefined) {
      observed.current = planId;
      return;
    }
    if (!focused || !planId || observed.current === planId) return;
    observed.current = planId;
    useLayout.getState().openThreadPanel(threadId, "plan");
  }, [isSuccess, planId, focused, threadId]);
  return null;
}
