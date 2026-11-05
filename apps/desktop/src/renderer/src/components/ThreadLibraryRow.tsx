import { ContextMenu } from "@base-ui/react/context-menu";
import { ownerMark, pullRequestMark, relativeTime, subagentStatusLabel, threadPlace, useTicking, workDuration, type ThreadPlace } from "@openorc/client";
import { harnessShortName, isHarnessId, type ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useLayout } from "../lib/layout";
import { orclingById, useOrclings } from "../lib/orclings";
import { useRouter } from "../lib/router";
import { endThreadDrag, startThreadDrag } from "../lib/thread-drag";
import { floatingGround } from "../lib/use-anchor-ground";
import { HarnessLogo } from "./HarnessLogo";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { ThreadRowHeadline } from "./ThreadHeadline";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { CircleCheck, CircleDashed, Cloud, Folder, GitBranch, GitPullRequest, X } from "./icons";
import { menuPopup } from "./menu";

const placeIcons: Record<ThreadPlace["kind"], ReactNode> = {
  branch: <GitBranch size={11} className="shrink-0" />,
  pull: <GitPullRequest size={11} className="shrink-0" />,
  folder: <Folder size={11} className="shrink-0" />,
};

/** The hover title for where a thread works: the branch, the pull request's address, or the folder. */
function placeTitle(thread: ThreadSummary, place: ThreadPlace): string {
  if (place.kind === "pull" && thread.prUrl) return thread.prUrl;
  if (place.kind === "folder") return thread.workingDirectory ?? "No recorded branch";
  return place.label;
}

const pullRequestTone = { open: "text-ink-4", merged: "text-ok", closed: "text-bad" } as const;

/** A resting thread's mark: the state of its pull request, if it has one. Most threads have none and show nothing. */
function PullRequestMark({ thread }: { thread: ThreadSummary }) {
  const mark = pullRequestMark(thread);
  if (!mark) return null;
  return (
    <span role="img" aria-label={mark.label} title={mark.label} className="size-4 shrink-0 inline-flex items-center justify-center">
      <GitPullRequest size={14} className={pullRequestTone[mark.state]} />
    </span>
  );
}

/**
 * A thread row: what the thread needs from you before its title, then the title. ⌘-click opens it in the split;
 * right-click gives every action.
 */
export function ThreadRow({ thread, active, projectName, compact = false }: { thread: ThreadSummary; active: boolean; projectName?: string; compact?: boolean }) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  // Every thread open in a pane is marked alike; aria-current names only the focused one.
  const open = useRouter((s) => s.threadIds.includes(thread.id)) || active;
  const orcling = orclingById(useOrclings(), thread.orclingId);
  const agents = thread.agents?.length ? thread.agents : [thread.agent];
  const providers = [...new Set(agents)].map((agent) => ({ agent, count: agents.filter((item) => item === agent).length }));
  const team = agents.length > 1;
  const agentLabel = providers.map(({ agent, count }) => `${team ? `${count} × ` : ""}${harnessShortName(agent)}`).join(", ");
  const place = threadPlace(thread);
  const title = placeTitle(thread, place);
  const mark = ownerMark(thread);
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
                if (useLayout.getState().projectId !== null) useLayout.getState().setProject(thread.projectId);
                dismissCompactNavigation();
                navigate({ view: "thread", threadId: thread.id });
              }
            }}
            aria-current={active ? "page" : undefined}
            data-open={open || undefined}
            className={`sidebar-thread-row thread-preview no-drag${compact ? " sidebar-thread-child" : ""}`}
            title={`${thread.title}\n${place.label} · ${agentLabel} · ${relativeTime(thread.lastActivityAt)}`}
          />
        }
      >
        {projectName ? (
          <span className="thread-preview-project" title={projectName}>
            {projectName}
          </span>
        ) : null}
        <span className="thread-preview-heading">
          <span className="thread-preview-status">
            <SidebarThreadMark thread={thread} />
          </span>
          <span className="thread-preview-title">{thread.title}</span>
          {compact && thread.subagent ? <SubagentRowMeta thread={thread} /> : null}
        </span>
        {!compact ? <ThreadRowHeadline thread={thread} /> : null}
        <span className="thread-preview-meta flex min-w-0 items-center gap-2 text-xs leading-4 text-ink-3">
          <span className="flex flex-1 min-w-0 items-center gap-1" title={title}>
            {placeIcons[place.kind]}
            <span className="truncate">{place.label}</span>
          </span>
          {mark ? (
            <span className={`inline-flex shrink-0 items-center gap-1${mark.dim ? " opacity-60" : ""}`}>
              <Cloud size={12} />
              {mark.label}
            </span>
          ) : null}
          {orcling ? (
            <span className="inline-flex shrink-0 items-center gap-1" title={orcling.name}>
              <OrclingAvatar orcling={orcling} size={12} />
              <span>{orcling.name}</span>
            </span>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1.5"
              role="img"
              aria-label={team ? `Agents: ${agentLabel}` : `Agent: ${agentLabel}`}
              title={team ? `Agents: ${agentLabel}` : agentLabel}
            >
              {providers.map(({ agent, count }) => (
                <span key={agent} className="inline-flex items-center gap-1">
                  {isHarnessId(agent) ? <HarnessLogo id={agent} size={12} className="shrink-0" /> : null}
                  <span className="tabular">{team ? count : harnessShortName(agent)}</span>
                </span>
              ))}
            </span>
          )}
          <span className="thread-preview-date">{relativeTime(thread.lastActivityAt)}</span>
        </span>
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

function SubagentRowMeta({ thread }: { thread: ThreadSummary }) {
  const child = thread.subagent;
  const now = useTicking(child?.status === "running");
  return child ? (
    <span className="sidebar-child-meta">
      {child.agentType ? <span>{child.agentType}</span> : null}
      {child.status === "running" ? <span className="tabular">{workDuration(now - child.startedAt)}</span> : null}
    </span>
  ) : null;
}

function SidebarThreadMark({ thread }: { thread: ThreadSummary }) {
  let Icon = X;
  if (thread.subagent?.status === "completed") Icon = CircleCheck;
  if (thread.subagent?.status === "no_updates") Icon = CircleDashed;
  return thread.subagent && thread.activity === "idle" ? (
    <span
      role="img"
      aria-label={subagentStatusLabel[thread.subagent.status]}
      title={subagentStatusLabel[thread.subagent.status]}
      className={thread.subagent.status === "failed" ? "text-bad" : undefined}
    >
      <Icon size={13} />
    </span>
  ) : (
    <ThreadStatusIndicator thread={thread} idle={<PullRequestMark thread={thread} />} />
  );
}
