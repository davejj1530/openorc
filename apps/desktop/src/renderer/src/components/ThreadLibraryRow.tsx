import { ContextMenu } from "@base-ui/react/context-menu";
import { useRef } from "react";
import {
  mentionLeads,
  ownerMark,
  rowFacts,
  subagentStatusLabel,
  threadMarkMotion,
  threadStatus,
  threadTreeStatus,
  useSidebarNow,
  useTicking,
  workDuration,
  type RunTranscript,
  type ThreadStatus,
} from "@openorc/client";
import { harnessShortName, type ThreadSummary } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { CoversPreview } from "../lib/browser-preview";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRun } from "../lib/client";
import { useRouter } from "../lib/router";
import { endThreadDrag, startThreadDrag } from "../lib/thread-drag";
import { floatingGround } from "../lib/use-anchor-ground";
import { useMentionWords } from "../lib/mention-words";
import { AccountFace } from "./AccountFace";
import { ThreadMenuItems, type MenuParts } from "./ThreadActions";
import { StateMark } from "./StateMark";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { CircleCheck, CircleDashed, Cloud, X } from "./icons";
import { menuPopup } from "./menu";

/** The project a sidebar row names, in a group that holds many projects. */
export type RowProject = { name: string };

type ThreadRowProps = {
  thread: ThreadSummary;
  subthreads?: ThreadStatus | null;
  active: boolean;
  project?: RowProject;
  compact?: boolean;
  /** Its sub threads show under it: with no state of its own it wears the resting cube, for their tree to hang from. */
  roots?: boolean;
};

/** Whether a row has a state to mark: its own or its sub threads' status, a subagent's result, an unread mention, or a pull request. */
export function rowHasState(thread: ThreadSummary, subthreads: ThreadStatus | null): boolean {
  const status = threadTreeStatus(threadStatus(thread), subthreads);
  return Boolean(status || thread.subagent || mentionLeads(thread, status) || thread.prUrl);
}

/**
 * A row's state, its title, then right-aligned facts. The state leads every row in one column, where a sub thread's
 * branch ends. Parent status includes its children; all open panes share the selected fill.
 */
export function ThreadRow({ thread, subthreads = null, active, project, compact = false, roots = false }: ThreadRowProps) {
  const navigate = useRouter((s) => s.navigate);
  const addPane = useRouter((s) => s.addThreadPane);
  // Every visible work pane is marked alike; aria-current names only the focused one.
  const open = useRouter((s) => s.route.view !== "team-chat" && s.threadIds.includes(thread.id)) || active;
  const menu = useRef<ContextMenu.Root.Actions>(null);
  const status = threadTreeStatus(threadStatus(thread), subthreads);
  const run = useRun(thread.liveRunId ?? undefined);
  const facts = rowFacts(thread, { now: useSidebarNow(), project: project?.name });
  const child = thread.subagent;
  const ticking = useTicking(child?.status === "running");
  const mentioned = useMentionWords(thread);
  const running = child?.status === "running" ? `Running for ${workDuration(ticking - child.startedAt)}` : null;
  const detail = [facts.detail, running, mentioned].filter(Boolean).join(" · ");
  const mention = mentionLeads(thread, status);
  return (
    <ContextMenu.Root actionsRef={menu}>
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
        <ThreadLine thread={thread} subthreads={subthreads} facts={facts} run={run} roots={roots} />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <CoversPreview />
        <ContextMenu.Positioner className="z-40" collisionPadding={8}>
          <ContextMenu.Popup ref={floatingGround} className={menuPopup}>
            <ThreadMenuItems thread={thread} parts={ContextMenu as unknown as MenuParts} close={() => menu.current?.close()} />
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

/** Every row keeps the lead slot, marked or not, so titles share one line and states one column. */
function ThreadLine({
  thread,
  subthreads,
  facts,
  run,
  roots,
}: {
  thread: ThreadSummary;
  subthreads: ThreadStatus | null;
  facts: ReturnType<typeof rowFacts>;
  run: RunTranscript | undefined;
  roots: boolean;
}) {
  const { starter, cloud } = facts;
  const slots = [
    { kind: "starter", mark: starter ? <AccountFace name={starter.name} image={starter.image} className="thread-preview-face" /> : null },
    {
      kind: "cloud",
      mark: cloud ? (
        <span role="img" aria-label={cloud} className={cn(thread.owner && thread.owner.reach !== "live" && "opacity-60")}>
          <Cloud size={14} />
        </span>
      ) : null,
    },
  ].filter((slot) => slot.mark !== null);
  // With nothing to say, a row whose sub threads show still wears the resting cube: their tree hangs from it.
  const resting = roots ? <StateMark motion={threadMarkMotion("resting")} /> : null;
  const lead = rowHasState(thread, subthreads) ? <SidebarThreadMark thread={thread} subthreads={subthreads} run={run} /> : resting;
  return (
    <span className="thread-preview-heading">
      <span className="thread-lead-slot" data-fact="state">
        {lead}
      </span>
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

/** A subagent at rest says how it ended; every other row wears its thread's cube, or its pull request's while it rests. */
function SidebarThreadMark({ thread, subthreads, run }: { thread: ThreadSummary; subthreads: ThreadStatus | null; run: RunTranscript | undefined }) {
  let Icon = X;
  if (thread.subagent?.status === "completed") Icon = CircleCheck;
  if (thread.subagent?.status === "no_updates") Icon = CircleDashed;
  return thread.subagent && thread.activity === "idle" && !subthreads ? (
    <span role="img" aria-label={subagentStatusLabel[thread.subagent.status]} className={cn(thread.subagent.status === "failed" && "text-bad")}>
      <Icon size={13} />
    </span>
  ) : (
    <ThreadStatusIndicator thread={thread} subthreads={subthreads} run={run} pull />
  );
}
