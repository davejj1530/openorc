import { ContextMenu } from "@base-ui/react/context-menu";
import {
  latestActivity,
  ownerMark,
  pullRequestMark,
  pullRequestNumber,
  rowAge,
  rowPlace,
  rowStarter,
  subagentStatusLabel,
  threadPlace,
  threadStatus,
  threadTreeStatus,
  useSidebarNow,
  useTicking,
  workDuration,
  type RowPlace,
  type ThreadStatus,
} from "@openorc/client";
import { harnessShortName, type ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import type { ComponentType } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRouter } from "../lib/router";
import { rowFit } from "../lib/row-fit";
import { endThreadDrag, startThreadDrag } from "../lib/thread-drag";
import { floatingGround } from "../lib/use-anchor-ground";
import { AccountFace } from "./AccountFace";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { CircleCheck, CircleDashed, Cloud, Folder, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, X } from "./icons";
import { menuPopup } from "./menu";

const placeIcons: Record<RowPlace["kind"], ComponentType<{ size?: number }>> = { cloud: Cloud, branch: GitBranch, worktree: Folder, folder: Folder };

const pullRequestTone = { open: undefined, merged: "text-ok", closed: "text-bad" } as const;
const pullRequestIcons = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;

/** A resting sub thread's mark: the state of its pull request, if it has one. Most threads have none and show nothing. */
function PullRequestMark({ thread }: { thread: ThreadSummary }) {
  const mark = pullRequestMark(thread);
  if (!mark) return null;
  const Icon = pullRequestIcons[mark.state];
  return (
    <span role="img" aria-label={mark.label} data-tip={mark.label} className="size-4 shrink-0 inline-flex items-center justify-center">
      <Icon size={14} className={pullRequestTone[mark.state] ?? "text-ink-3"} />
    </span>
  );
}

/** A thread's pull request at the end of its second line: the state's own icon and color, then the number. */
function PullRequestStatus({ thread }: { thread: ThreadSummary }) {
  const mark = pullRequestMark(thread);
  if (!mark) return null;
  const Icon = pullRequestIcons[mark.state];
  return (
    <span className={cn("thread-preview-pull", pullRequestTone[mark.state])} role="img" aria-label={mark.label}>
      <Icon size={12} />
      <span className="tabular">#{pullRequestNumber(thread.prUrl)}</span>
    </span>
  );
}

/** The project a sidebar row names, in a group that holds many projects. */
export type RowProject = { name: string };

type ThreadRowProps = { thread: ThreadSummary; subthreads?: ThreadStatus | null; active: boolean; project?: RowProject; compact?: boolean };

/**
 * A thread row: its title with what it needs from you at the end, then how fresh it is, whose, where and its pull
 * request. A sub thread keeps its mark ahead of its title, where the tree's lines reach it. A parent's mark also tells of
 * its sub threads (`subthreads`) while they need you or work. ⌘-click opens it in the split; right-click gives every
 * action.
 */
export function ThreadRow({ thread, subthreads = null, active, project, compact = false }: ThreadRowProps) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  // Every thread open in a pane is marked alike; aria-current names only the focused one.
  const open = useRouter((s) => s.threadIds.includes(thread.id)) || active;
  const status = threadTreeStatus(threadStatus(thread), subthreads);
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
            aria-description={rowDescription(thread)}
            data-open={open || undefined}
            data-attention={(status && status.kind !== "running" && status.kind !== "background") || undefined}
            className={cn("sidebar-thread-row thread-preview no-drag", compact && "sidebar-thread-child")}
          />
        }
      >
        {compact ? <SubThreadLines thread={thread} subthreads={subthreads} /> : <ThreadLines thread={thread} subthreads={subthreads} project={project} />}
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

/**
 * What a row leaves to its spoken description: a subagent's kind, or where any other thread works and whether its
 * host answers, then its agents.
 */
function rowDescription(thread: ThreadSummary): string {
  const agents = thread.agents?.length ? thread.agents : [thread.agent];
  const about = thread.subagent ? ["Subagent", thread.subagent.agentType] : [threadPlace(thread).label, ownerMark(thread)?.label];
  return [...about, [...new Set(agents)].map(harnessShortName).join(", ")].filter(Boolean).join(" · ");
}

/**
 * A thread's two lines: its title, cut whole into its tooltip, with its mark at the end (the cube while it works, what it
 * or a sub thread needs from you, a failure or an unread dot); then, from the left, how fresh it is, whose it is when a
 * teammate started it, and where it works when that is not the project's usual place, and at the right its pull
 * request. A row in a group of many projects (Pinned, Snoozed, Resolved) names its project after the age.
 */
function ThreadLines({ thread, subthreads, project }: { thread: ThreadSummary; subthreads: ThreadStatus | null; project?: RowProject }) {
  const now = useSidebarNow();
  const usual = useRpc("app.settings.get", {}).data?.defaultWorkspaceMode ?? "current";
  const place = rowPlace(thread, usual);
  const starter = rowStarter(thread);
  return (
    <>
      <span className="thread-preview-heading">
        <span className="thread-preview-title" data-tip={thread.title}>
          {thread.title}
        </span>
        <span className="thread-preview-mark">
          <SidebarThreadMark thread={thread} subthreads={subthreads} pull={false} />
        </span>
      </span>
      <span ref={rowFit} className="thread-preview-line">
        <span className="tabular">{rowAge(latestActivity(thread), now)}</span>
        {project ? (
          <span className="thread-preview-project" data-tip={project.name}>
            {project.name}
          </span>
        ) : null}
        {starter ? (
          <span className="thread-preview-who" data-tip={starter.name}>
            <AccountFace name={starter.name} image={starter.image} className="thread-preview-face" />
            <span className="thread-preview-word">{starter.first}</span>
          </span>
        ) : null}
        {place ? <RowPlaceMark place={place} thread={thread} /> : null}
        <PullRequestStatus thread={thread} />
      </span>
    </>
  );
}

/** Where the thread works: its glyph and word; a cloud dims while its host can't be reached and keeps its glyph when the word gives way. */
function RowPlaceMark({ place, thread }: { place: RowPlace; thread: ThreadSummary }) {
  const Icon = placeIcons[place.kind];
  const cloud = place.kind === "cloud";
  return (
    <span
      className={cn("thread-preview-place", cloud && thread.owner && thread.owner.reach !== "live" && "opacity-60")}
      data-cloud={cloud || undefined}
      data-tip={cloud ? place.label : place.word}
      {...(cloud ? { role: "img", "aria-label": place.label } : {})}
    >
      <Icon size={12} />
      {place.word ? <span className="thread-preview-word">{place.word}</span> : null}
    </span>
  );
}

/** A sub thread's one line: its mark where the tree's line reaches it, its title, then how long a subagent has been running. */
function SubThreadLines({ thread, subthreads }: { thread: ThreadSummary; subthreads: ThreadStatus | null }) {
  return (
    <span className="thread-preview-heading">
      <span className="thread-preview-status">
        <SidebarThreadMark thread={thread} subthreads={subthreads} pull />
      </span>
      <span className="thread-preview-title" data-tip={thread.title}>
        {thread.title}
      </span>
      {thread.subagent ? <SubagentRunTime thread={thread} /> : null}
    </span>
  );
}

function SubagentRunTime({ thread }: { thread: ThreadSummary }) {
  const child = thread.subagent;
  const running = child?.status === "running";
  const now = useTicking(running);
  return child && running ? <span className="sidebar-child-meta tabular">{workDuration(now - child.startedAt)}</span> : null;
}

/**
 * What a thread or its sub threads need from you or are doing, a finished subagent's outcome, or at rest its pull request
 * when no project line shows it.
 */
function SidebarThreadMark({ thread, subthreads, pull }: { thread: ThreadSummary; subthreads: ThreadStatus | null; pull: boolean }) {
  let Icon = X;
  if (thread.subagent?.status === "completed") Icon = CircleCheck;
  if (thread.subagent?.status === "no_updates") Icon = CircleDashed;
  return thread.subagent && thread.activity === "idle" && !subthreads ? (
    <span
      role="img"
      aria-label={subagentStatusLabel[thread.subagent.status]}
      data-tip={subagentStatusLabel[thread.subagent.status]}
      className={thread.subagent.status === "failed" ? "text-bad" : undefined}
    >
      <Icon size={13} />
    </span>
  ) : (
    <ThreadStatusIndicator thread={thread} subthreads={subthreads} idle={pull ? <PullRequestMark thread={thread} /> : null} />
  );
}
