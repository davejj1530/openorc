import { harnessShortName, isHarnessId, WORKSPACE_ID, type ThreadSummary } from "@openorc/protocol";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import { Folder, GitBranch, GitPullRequest } from "./icons";
import { HarnessLogo } from "./HarnessLogo";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { ThreadRowHeadline } from "./ThreadHeadline";
import { menuPopup, ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { cn } from "../lib/cn";
import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { startThreadDrag, endThreadDrag } from "../lib/thread-drag";
import { CoversPreview } from "../lib/browser-preview";
import { pullRequestNumber } from "../lib/pull-requests";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { relativeTime } from "../lib/time";
import { orclingById, useOrclings } from "../lib/orclings";
import { OrclingAvatar } from "./OrclingAvatar";

/** Where a thread works, as its row shows it: its branch, the pull request it reviews, or its folder. */
function threadPlace(thread: ThreadSummary): { icon: ReactNode; label: string; title: string } {
  if (thread.branch) return { icon: <GitBranch size={11} className="shrink-0" />, label: thread.branch, title: thread.branch };
  const pull = pullRequestNumber(thread.prUrl);
  if (thread.prUrl && pull !== null) return { icon: <GitPullRequest size={11} className="shrink-0" />, label: `PR #${pull}`, title: thread.prUrl };
  return { icon: <Folder size={11} className="shrink-0" />, label: thread.projectId === WORKSPACE_ID ? "Local" : "No branch", title: thread.workingDirectory ?? "No recorded branch" };
}

const pullRequestTone = { open: "text-ink-3", merged: "text-ok", closed: "text-bad" } as const;

/** A resting thread's mark: the state of its pull request, if it has one. Most threads have none and show nothing. */
function PullRequestMark({ thread }: { thread: ThreadSummary }) {
  const pull = pullRequestNumber(thread.prUrl);
  if (pull === null) return null;
  const state = thread.prState ?? "open";
  return (
    <span role="img" aria-label={`Pull request #${pull}, ${state}`} title={`Pull request #${pull}, ${state}`} className="size-3.5 shrink-0 inline-flex items-center justify-center">
      <GitPullRequest size={13} className={pullRequestTone[state]} />
    </span>
  );
}

/**
 * A thread row: what the thread needs from you before its title, then the title. ⌘-click opens it in the split;
 * right-click gives every action.
 */
export function ThreadRow({ thread, active }: { thread: ThreadSummary; active: boolean }) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  const split = useRouter((s) => s.threadIds.includes(thread.id));
  const orcling = orclingById(useOrclings(), thread.orclingId);
  const agents = thread.agents?.length ? thread.agents : [thread.agent];
  const providers = [...new Set(agents)].map((agent) => ({ agent, count: agents.filter((item) => item === agent).length }));
  const team = agents.length > 1;
  const agentLabel = providers.map(({ agent, count }) => `${team ? `${count} × ` : ""}${harnessShortName(agent)}`).join(", ");
  const place = threadPlace(thread);
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
            className={cn(
              "sidebar-thread-row thread-preview no-drag min-w-0 w-full flex flex-col items-stretch gap-0.5 px-2 py-1.5 rounded-md text-base text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
              active && "text-ink",
              split && !active && "ring-1 ring-inset ring-line-strong",
            )}
            title={`${thread.title}\n${place.label} · ${agentLabel} · ${relativeTime(thread.lastActivityAt)}`}
          />
        }
      >
        <span className="thread-preview-heading flex min-w-0 items-start">
          <span className="thread-preview-status">
            <ThreadStatusIndicator thread={thread} idle={<PullRequestMark thread={thread} />} />
          </span>
          <span className={cn("thread-preview-title flex-1 min-w-0 text-left", (active || thread.unread || thread.activity === "waiting") && "text-ink")}>{thread.title}</span>
        </span>
        <ThreadRowHeadline thread={thread} />
        <span className="thread-preview-meta flex min-w-0 items-center gap-2 text-xs leading-4 text-ink-3">
          <span className="flex flex-1 min-w-0 items-center gap-1" title={place.title}>
            {place.icon}
            <span className="truncate">{place.label}</span>
          </span>
          {orcling ? (
            <span className="inline-flex shrink-0 items-center gap-1" title={orcling.name}>
              <OrclingAvatar orcling={orcling} size={12} />
              <span>{orcling.name}</span>
            </span>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1.5"
              role="img"
              aria-label={team ? `Team agents: ${agentLabel}` : `Agent: ${agentLabel}`}
              title={team ? `Team agents: ${agentLabel}` : agentLabel}
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
          <ContextMenu.Popup className={menuPopup}>
            <ThreadMenuItems thread={thread} parts={ContextMenu as unknown as MenuParts} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
