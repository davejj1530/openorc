import { Menu } from "@base-ui/react/menu";
import { snoozeWakeLabel } from "@openorc/client";
import type { CloudThreadState, ThreadSummary as Thread } from "@openorc/protocol";
import { isSubagentThread } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { openThread, useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { ThreadOrcling } from "./OrclingAvatar";
import { ThreadParent } from "./SubagentConversation";
import { ThreadMenuItems } from "./ThreadActions";
import { ThreadTabs } from "./ThreadTabs";
import { ThreadTitle } from "./ThreadTitle";
import { ThreadTools } from "./ThreadTools";
import { TopBar } from "./TopBar";
import { AlarmClock, ArrowLeft, Cloud, GitFork, GitPullRequest, MoreVertical, X } from "./icons";
import { menuItem, menuPopup } from "./menu";
import { IconButton, StatusDot, Tooltip } from "./ui";

/** Whether the header starts or ends the work row, which decides who clears the native window controls. */
type Placement = { first: boolean; last: boolean; onClose?: () => void };

const prDot = { open: "muted", merged: "ok", closed: "bad" } as const;

/** The pane's close control, a round button at the header's end. */
function ClosePane({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null;
  return (
    <Tooltip label="Close pane">
      <IconButton onClick={onClose} aria-label="Close pane">
        <X size={16} />
      </IconButton>
    </Tooltip>
  );
}

/** While a thread loads or can't be found, its header still offers the way back. */
export function ThreadHeaderPlaceholder({ loading, first, last, onClose }: Placement & { loading: boolean }) {
  const back = useRouter((s) => s.back);
  return (
    <TopBar windowDragSurface inSplit={!first} rightmost={last} actions={<ClosePane onClose={onClose} />}>
      <Tooltip label="Back">
        <IconButton onClick={back} aria-label="Back">
          <ArrowLeft size={16} />
        </IconButton>
      </Tooltip>
      <span className="thread-header-project">{loading ? "Loading…" : "Thread not found"}</span>
    </TopBar>
  );
}

/**
 * A quiet thread header: the title, then a faint run of facts (activity, pull request, snooze), then More, the
 * thread's tools and Close pane as round buttons. The project is the sidebar filter's, the Claude account the model picker's. The first pane's header holds the work
 * column's tabs in place of the title, its facts moving beside the buttons. The header never activates a pane.
 */
export function ThreadHeader({
  thread: t,
  renaming,
  onRenamingChange,
  onRename,
  first,
  last,
  onClose,
}: Placement & {
  thread: Thread;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  onRename: (title: string) => void;
}) {
  // Before a split pane's title the parent reads as a crumb; among the first pane's facts, as a fact of its own.
  const lineage = (fact: boolean) => (
    <>
      {t.parentThreadId ? <ThreadParent id={t.parentThreadId} fact={fact} /> : <ForkParent parent={t.forkedFromId} />}
      <ThreadOrcling threadId={t.id} orclingId={t.orclingId} />
    </>
  );
  const facts = (
    <span className="thread-header-facts">
      {first ? lineage(true) : null}
      <ThreadFacts thread={t} />
    </span>
  );
  return (
    <TopBar
      windowDragSurface
      tabs={first}
      inSplit={!first}
      rightmost={last}
      actions={
        <>
          {first ? facts : null}
          <ClosePane onClose={onClose} />
          <Menu.Root>
            <Menu.Trigger render={<IconButton aria-label="Thread actions" className="thread-more" />}>
              <MoreVertical size={16} />
            </Menu.Trigger>
            <Menu.Portal>
              <CoversPreview />
              <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
                <Menu.Popup ref={floatingGround} className={menuPopup} finalFocus={renaming ? false : undefined}>
                  {!isSubagentThread(t) ? (
                    <Menu.Item className={menuItem} onClick={() => onRenamingChange(true)}>
                      Rename
                    </Menu.Item>
                  ) : null}
                  <ThreadMenuItems thread={t} parts={Menu} />
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {!isSubagentThread(t) ? <ThreadTools threadId={t.id} /> : null}
        </>
      }
    >
      {first ? (
        <ThreadTabs
          title={renaming ? <ThreadTitle title={t.title} editing onEditingChange={onRenamingChange} onSave={onRename} /> : undefined}
          {...(isSubagentThread(t) ? {} : { onRename: () => onRenamingChange(true) })}
        />
      ) : (
        <>
          {lineage(false)}
          {isSubagentThread(t) ? <span className="truncate text-sm">{t.title}</span> : <ThreadTitle title={t.title} editing={renaming} onEditingChange={onRenamingChange} onSave={onRename} />}
          {facts}
        </>
      )}
    </TopBar>
  );
}

const cloudDot = { preparing: "live", failed: "bad", ready: null, removed: null } as const;

const cloudPlaces = {
  vercel: { label: "Vercel", tip: "Runs in Vercel Sandbox" },
  agent37: { label: "Agent37", tip: "Runs in an Agent37 instance" },
  local: { label: "Simulated", tip: "Runs in a sandbox simulated on this Mac" },
} as const;

function cloudTip(cloud: CloudThreadState, where: string): string {
  if (cloud.state === "failed" && cloud.error) return cloud.error;
  return cloud.state === "removed" ? "Its sandbox was removed; the next message sets up a new one" : where;
}

/** Where a cloud thread runs, with a dot while its sandbox is set up or after that failed. */
function ThreadCloud({ cloud }: { cloud: CloudThreadState }) {
  const place = cloudPlaces[cloud.provider];
  const dot = cloudDot[cloud.state];
  return (
    <Tooltip label={cloudTip(cloud, place.tip)}>
      <span className="thread-header-fact">
        <Cloud size={12} />
        {dot ? <StatusDot tone={dot} /> : null}
        {place.label}
      </span>
    </Tooltip>
  );
}

/** Where a cloud thread runs, activity, the pull request and snooze, as faint words with small marks. */
function ThreadFacts({ thread: t }: { thread: Thread }) {
  const snoozed = t.snoozedUntil && t.snoozedUntil > Date.now();
  return (
    <>
      {t.cloud ? <ThreadCloud cloud={t.cloud} /> : null}
      {!t.teamInstanceId && t.activity !== "idle" ? (
        <span className="thread-header-fact">
          <StatusDot tone={t.activity === "waiting" ? "attention" : "live"} />
          {t.activity === "waiting" ? "needs you" : "working"}
        </span>
      ) : null}
      {t.prUrl ? (
        <Tooltip label={t.prUrl}>
          <button type="button" className="thread-header-fact thread-header-fact-link" onClick={() => window.openorc.openExternal(t.prUrl as string)} aria-label="Open the pull request">
            <GitPullRequest size={12} />
            <StatusDot tone={prDot[t.prState ?? "open"]} />
            {t.prState ?? "PR"}
          </button>
        </Tooltip>
      ) : null}
      {snoozed ? (
        <span className="thread-header-fact">
          <AlarmClock size={12} />
          until {snoozeWakeLabel(t.snoozedUntil as number)}
        </span>
      ) : null}
    </>
  );
}

/** A fork links back to the thread it continues. */
function ForkParent({ parent }: { parent: string | null }) {
  if (!parent) return null;
  return (
    <Tooltip label="Forked from another thread">
      <IconButton size="xs" onClick={() => openThread(parent)} aria-label="Open the parent thread" className="text-ink-4">
        <GitFork size={13} />
      </IconButton>
    </Tooltip>
  );
}
