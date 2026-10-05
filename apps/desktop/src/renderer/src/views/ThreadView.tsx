import { useEffect, useRef, useState } from "react";
import { AlarmClock, ArrowLeft, GitFork, GitPullRequest, MoreHorizontal, X } from "../components/icons";
import { Menu } from "@base-ui/react/menu";
import { ThreadTitle } from "../components/ThreadTitle";
import { ThreadTools } from "../components/ThreadTools";
import { Conversation } from "../components/Conversation";
import { menuItem, menuPopup, ThreadMenuItems } from "../components/ThreadActions";
import { TopBar } from "../components/TopBar";
import { ThreadOrcling } from "../components/OrclingAvatar";
import { Badge, IconButton, TextButton, Tooltip } from "../components/ui";
import { useLayout } from "../lib/layout";
import { useRpc, useRpcMutation } from "../lib/query";
import { useConversationPlans } from "../lib/conversation-plans";
import { openThread, useRouter } from "../lib/router";
import { CoversPreview } from "../lib/browser-preview";

const prTone = { open: "muted", merged: "ok", closed: "bad" } as const;

/**
 * A stable, thread-scoped conversation. The workspace owns the shared panel.
 */
export function ThreadView({ threadId, first, last, focused, onClose }: { threadId: string; first: boolean; last: boolean; focused: boolean; onClose?: () => void }) {
  const thread = useRpc("threads.get", { id: threadId });
  const project = useRpc("projects.get", { id: thread.data?.projectId ?? "" }, { enabled: Boolean(thread.data) });
  const back = useRouter((s) => s.back);
  const update = useRpcMutation("threads.update");
  const setProject = useLayout((s) => s.setProject);
  const panelOpen = useLayout((s) => s.panelOpen);
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
        <TopBar
          windowDragSurface
          showProject={false}
          inSplit={!first}
          rightmost={last && !panelOpen}
          actions={
            onClose ? (
              <IconButton onClick={onClose} aria-label="Close pane">
                <X size={15} />
              </IconButton>
            ) : undefined
          }
        >
          <TextButton onClick={back} tone="muted" className="mr-1" title="Back">
            <ArrowLeft size={16} />
          </TextButton>
          <span className="text-ink-3 font-normal">{thread.isLoading || project.isLoading ? "Loading…" : "Thread not found"}</span>
        </TopBar>
      </main>
    );
  }

  return (
    <>
      <RevealEmittedPlan key={threadId} threadId={threadId} focused={focused} team={Boolean(t.teamInstanceId)} />
      <main className="workspace-main well flex-1 min-w-0 flex flex-col">
        <TopBar
          windowDragSurface
          showProject={false}
          inSplit={!first}
          rightmost={last && !panelOpen}
          actions={
            <>
              {t.teamInstanceId ? <span ref={setTeamToolbar} className="thread-team-toolbar" /> : null}
              {!t.teamInstanceId && t.activity !== "idle" ? <Badge tone={t.activity === "waiting" ? "warn" : "accent"}>{t.activity === "waiting" ? "needs you" : "working"}</Badge> : null}
              {t.prUrl ? (
                <Tooltip label={t.prUrl}>
                  <TextButton onClick={() => window.openorc.openExternal(t.prUrl as string)} className="inline-flex" aria-label="Open the pull request">
                    <Badge tone={prTone[t.prState ?? "open"]}>
                      <GitPullRequest size={11} className="mr-1" /> {t.prState ?? "PR"}
                    </Badge>
                  </TextButton>
                </Tooltip>
              ) : null}
              {t.snoozedUntil && t.snoozedUntil > Date.now() ? (
                <Badge>
                  <AlarmClock size={11} className="mr-1" /> until {new Date(t.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                </Badge>
              ) : null}
              {onClose ? (
                <Tooltip label="Close pane">
                  <IconButton onClick={onClose} aria-label="Close pane">
                    <X size={15} />
                  </IconButton>
                </Tooltip>
              ) : null}
              <Menu.Root>
                <Menu.Trigger render={<IconButton aria-label="Thread actions" />}>
                  <MoreHorizontal size={15} />
                </Menu.Trigger>
                <Menu.Portal>
                  <CoversPreview />
                  <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
                    <Menu.Popup className={menuPopup} finalFocus={renaming ? false : undefined}>
                      <Menu.Item className={menuItem} onClick={() => setRenaming(true)}>
                        Rename
                      </Menu.Item>
                      <ThreadMenuItems thread={t} parts={Menu} />
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
              <ThreadTools threadId={threadId} />
            </>
          }
        >
          <ForkParent parent={t.forkedFromId} />
          <ThreadOrcling threadId={t.id} orclingId={t.orclingId} />
          <ThreadTitle title={t.title} editing={renaming} onEditingChange={setRenaming} onSave={(title) => update.mutate({ id: t.id, patch: { title } })} />
          <span className="thread-header-project" title={p.rootPath}>
            {p.name}
          </span>
        </TopBar>
        {/* Header controls own their thread explicitly; only conversation interaction activates a pane. */}
        <div className="thread-pane-content flex-1 min-h-0" onPointerDownCapture={activate} onFocusCapture={activate}>
          <Conversation key={t.id} scope={{ kind: "thread", thread: t }} project={p} toolbarTarget={teamToolbar} />
        </div>
      </main>
    </>
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

export { menuItem };

/** A fork links back to the thread it continues. */
function ForkParent({ parent }: { parent: string | null }) {
  if (!parent) return null;
  return (
    <Tooltip label="Forked from another thread">
      <TextButton onClick={() => openThread(parent)} tone="muted" aria-label="Open the parent thread">
        <GitFork size={13} />
      </TextButton>
    </Tooltip>
  );
}
