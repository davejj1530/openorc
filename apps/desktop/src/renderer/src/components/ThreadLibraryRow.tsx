import { ContextMenu } from "@base-ui/react/context-menu";
import { mentionLeads, ownerMark, rowFacts, subagentStatusLabel, threadStatus, threadTreeStatus, useSidebarNow, useTicking, workDuration, type ThreadStatus } from "@openorc/client";
import { harnessShortName, type ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { endThreadDrag, startThreadDrag } from "../lib/thread-drag";
import { floatingGround } from "../lib/use-anchor-ground";
import { useMentionWords } from "../lib/mention-words";
import { AccountFace } from "./AccountFace";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { CircleCheck, CircleDashed, Cloud, GitMerge, GitPullRequest, GitPullRequestClosed, X } from "./icons";
import { menuPopup } from "./menu";

const pullRequestTone = { open: "text-ink-3", merged: "text-ok", closed: "text-bad" } as const;
const pullRequestIcons = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;

/** The project a sidebar row names, in a group that holds many projects. */
export type RowProject = { name: string };

type ThreadRowProps = { thread: ThreadSummary; subthreads?: ThreadStatus | null; active: boolean; project?: RowProject; compact?: boolean };

/** A title and right-aligned facts. Parent status includes its children; all open panes share the selected fill. */
export function ThreadRow({ thread, subthreads = null, active, project, compact = false }: ThreadRowProps) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  // Every visible work pane is marked alike; aria-current names only the focused one.
  const open = useRouter((s) => s.route.view !== "team-chat" && s.threadIds.includes(thread.id)) || active;
  const status = threadTreeStatus(threadStatus(thread), subthreads);
  const facts = rowFacts(thread, { now: useSidebarNow(), project: project?.name });
  const child = thread.subagent;
  const ticking = useTicking(child?.status === "running");
  const mentioned = useMentionWords(thread);
  const running = child?.status === "running" ? `Running for ${workDuration(ticking - child.startedAt)}` : null;
  const detail = [facts.detail, running, mentioned].filter(Boolean).join(" · ");
  const mention = mentionLeads(thread, status);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            draggable
            onDragStart={(event) => startThreadDrag(event.dataTransfer, thread.id)}
            onDragEnd={endThreadDrag}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) addPane(thread.id);
              else {
                dismissCompactNavigation();
                navigate({ view: "thread", threadId: thread.id });
              }
            }}
            aria-current={active ? "page" : undefined}
            aria-description={rowDescription(thread, detail)}
            data-tip={thread.title}
            data-tip-detail={detail}
            data-open={open || undefined}
            data-attention={mention || (status && status.kind !== "running" && status.kind !== "background") || undefined}
            className={cn("sidebar-thread-row thread-preview no-drag", compact && "sidebar-thread-child")}
          />
        }
      >
        <ThreadLine thread={thread} subthreads={subthreads} facts={facts} status={status} mention={mention} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner className="z-40" collisionPadding={8}>
          <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
            <ThreadMenuItems thread={thread} parts={ContextMenu as unknown as MenuParts} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Spoken facts include the host's reach, the subagent's type and the agents used. */
function rowDescription(thread: ThreadSummary, detail: string): string {
  const agents = thread.agents?.length ? thread.agents : [thread.agent];
  const about = thread.subagent ? ["Subagent", thread.subagent.agentType] : [];
  return [detail, ...about, ownerMark(thread)?.label, [...new Set(agents)].map(harnessShortName).join(", ")].filter(Boolean).join(" · ");
}

function ThreadLine({
  thread,
  subthreads,
  facts,
  status,
  mention,
}: {
  thread: ThreadSummary;
  subthreads: ThreadStatus | null;
  facts: ReturnType<typeof rowFacts>;
  status: ThreadStatus | null;
  mention: boolean;
}) {
  const { starter, pull, cloud } = facts;
  const PullIcon = pull ? pullRequestIcons[pull.state] : GitPullRequest;
  const state = status || thread.subagent || mention ? <SidebarThreadMark thread={thread} subthreads={subthreads} /> : null;
  const slots = [
    { kind: "starter", mark: starter ? <AccountFace name={starter.name} image={starter.image} className="thread-preview-face" /> : null },
    {
      kind: "pull",
      mark: pull ? (
        <span role="img" aria-label={pull.label} className={pullRequestTone[pull.state]}>
          <PullIcon size={14} />
        </span>
      ) : null,
    },
    {
      kind: "cloud",
      mark: cloud ? (
        <span role="img" aria-label={cloud} className={cn(thread.owner && thread.owner.reach !== "live" && "opacity-60")}>
          <Cloud size={14} />
        </span>
      ) : null,
    },
    { kind: "state", mark: state },
  ].filter((slot) => slot.mark !== null);
  return (
    <span className="thread-preview-heading">
      <span className="thread-preview-title" data-tip-title>
        {thread.title}
      </span>
      {slots.length ? (
        <span className="thread-facts">
          {slots.map(({ kind, mark }) => (
            <span key={kind} className="thread-fact-slot" data-fact={kind}>
              {mark}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** State remains last, separate from the pull request. */
function SidebarThreadMark({ thread, subthreads }: { thread: ThreadSummary; subthreads: ThreadStatus | null }) {
  let Icon = X;
  if (thread.subagent?.status === "completed") Icon = CircleCheck;
  if (thread.subagent?.status === "no_updates") Icon = CircleDashed;
  return thread.subagent && thread.activity === "idle" && !subthreads ? (
    <span role="img" aria-label={subagentStatusLabel[thread.subagent.status]} className={cn(thread.subagent.status === "failed" && "text-bad")}>
      <Icon size={13} />
    </span>
  ) : (
    <ThreadStatusIndicator thread={thread} subthreads={subthreads} />
  );
}
