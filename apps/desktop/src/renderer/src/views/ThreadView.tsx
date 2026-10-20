import { ClaudeAccountScope } from "../lib/claude-account";
import { useEffect, useRef, useState } from "react";
import { Conversation } from "../components/Conversation";
import { ThreadHeader, ThreadHeaderPlaceholder } from "../components/ThreadHeader";
import { useLayout } from "../lib/layout";
import { useRpc, useRpcMutation } from "../lib/query";
import { useConversationPlans } from "../lib/conversation-plans";
import { useRouter } from "../lib/router";

/**
 * A stable, thread-scoped conversation. The workspace owns the shared panel.
 */
export function ThreadView({ threadId, first, last, focused, onClose }: { threadId: string; first: boolean; last: boolean; focused: boolean; onClose?: () => void }) {
  const thread = useRpc("threads.get", { id: threadId });
  const project = useRpc("projects.get", { id: thread.data?.projectId ?? "" }, { enabled: Boolean(thread.data) });
  const update = useRpcMutation("threads.update");
  const setProject = useLayout((s) => s.setProject);
  const [renaming, setRenaming] = useState(false);
  const [teamToolbar, setTeamToolbar] = useState<HTMLSpanElement | null>(null);
  const activate = () => {
    if (!focused) useRouter.getState().focusThreadPane(threadId);
  };
  const t = thread.data;
  const p = project.data;

  // Opening a thread selects its project in the rail, unless the rail shows every project.
  useEffect(() => {
    if (t && focused && useLayout.getState().projectId !== null) setProject(t.projectId);
  }, [t, focused, setProject]);

  // Looking at the thread reads it. A reply that lands while the window is elsewhere stays unread until the user comes back.
  useEffect(() => {
    if (!t?.unread) return;
    const mark = () => {
      if (document.hasFocus()) update.mutate({ id: t.id, patch: { seen: true } });
    };
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Resubscribe on new unread activity, not on this effect's own seen-mutation status updates.
  }, [t?.id, t?.unread, t?.lastActivityAt]);

  useEffect(() => {
    if (thread.isSuccess && !t) useRouter.getState().closeThreadPane(threadId);
  }, [thread.isSuccess, t, threadId]);

  if (!t || !p) {
    return (
      <main className="workspace-main well flex-1 min-w-0 flex flex-col">
        <ThreadHeaderPlaceholder loading={thread.isLoading || project.isLoading} first={first} last={last} onClose={onClose} />
      </main>
    );
  }

  return (
    <ClaudeAccountScope id={t.claudeAccountId ?? "claude-cli"}>
      <RevealEmittedPlan key={threadId} threadId={threadId} focused={focused} team={Boolean(t.teamInstanceId)} />
      <main className="workspace-main well flex-1 min-w-0 flex flex-col">
        <ThreadHeader
          thread={t}
          project={p}
          renaming={renaming}
          onRenamingChange={setRenaming}
          onRename={(title) => update.mutate({ id: t.id, patch: { title } })}
          onTeamToolbar={setTeamToolbar}
          first={first}
          last={last}
          onClose={onClose}
        />
        {/* Header controls own their thread explicitly; only conversation interaction activates a pane. */}
        <div className="thread-pane-content flex-1 min-h-0" onPointerDownCapture={activate} onFocusCapture={activate}>
          <Conversation key={t.id} scope={{ kind: "thread", thread: t }} project={p} toolbarTarget={teamToolbar} />
        </div>
      </main>
    </ClaudeAccountScope>
  );
}

/** Observe plan arrivals separately so streamed text doesn't rerender the conversation. */
function RevealEmittedPlan({ threadId, focused, team }: { threadId: string; focused: boolean; team: boolean }) {
  const { plans, isSuccess } = useConversationPlans(threadId, team);
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
