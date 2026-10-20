import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps, type RefObject } from "react";
import { useVisited } from "../lib/use-visited";
import { harnessCatalog, type ActivityRecovery } from "@openorc/protocol";
import { WorkMessage, WorkAgent, ChevronDown, ChevronRight, FileText, GitFork, Lightbulb, Loader2 } from "./icons";
import { workTurns } from "../lib/work-transcript";
import { cn } from "../lib/cn";
import type { FileSelection } from "../lib/layout";
import type { Block, RunTranscript } from "../lib/transcript";
import { QuestionCard } from "./QuestionCard";
import { AgentPresence } from "./AgentPresence";
import { liveVerb, stateLabel, toolCallPresentation, type Tone } from "./tool-presentation";
import { foldable } from "./work-steps";
import { WorkNow, WorkSteps } from "./WorkSteps";
import { TurnHead } from "./TurnHead";
import { TurnReceipt } from "./TurnReceipt";
import { useTurnModel } from "./use-turn-model";
import { useTurnAuthor } from "../lib/turn-authors";
import { ToolRow } from "./ToolRow";
import { ApprovalCard, pretty } from "./ApprovalCard";
export { AgentPresence } from "./AgentPresence";
import { StartedThreadCard } from "./StartedThreadCard";
import { TaskCard } from "./TaskCard";
import { startedWorkFromTool, taskIdFromTool, uniqueTaskCards } from "../lib/task-progress";
import { UsageRecovery } from "./UsageRecovery";
import { SignInRecovery } from "./SignInRecovery";
import { TranscriptErrorCard } from "./TranscriptErrorCard";
import { IconButton, TextButton } from "./ui";
import { ImageGenerationRow, ImageViewRow, ThreadImage, ThreadMedia, ThreadRichText } from "./ThreadImages";
import { isImageGeneration, isImageView } from "../lib/image-activity";
import { isUnifiedDiff } from "../lib/chat-diff";
import { isImagePath } from "../../../shared/image-paths";
import { CopyMessage, MessageTime, TurnActions } from "./MessageActions";

const InlineDiff = lazy(() => import("./InlineDiff").then((m) => ({ default: m.InlineDiff })));
const diffLoading = (
  <p role="status" className="my-2 text-xs text-ink-3">
    Loading diff…
  </p>
);

/**
 * The conversation as a plain list. Only the loaded turns are here: older ones
 * load as the reader nears the top, without moving what they are reading.
 * Each block is memoized, so only the one being streamed re-renders, and
 * off-screen blocks skip layout via CSS.
 */
export function Transcript({
  run,
  scrollKey = run.runId,
  onFork,
  trailing,
  basePath,
  fileScope,
  mentionNames,
  children,
  working = false,
  hasOlder = false,
  onLoadOlder,
  followKey,
}: {
  basePath?: string;
  fileScope?: FileSelection["scope"];
  mentionNames?: ReadonlyMap<string, string>;
  run: RunTranscript;
  scrollKey?: string;
  /** Continues the whole conversation in a new thread. */
  onFork?: () => void;
  trailing?: (blocks: Block[]) => ReactNode;
  children?: ReactNode;
  working?: boolean;
  /** More turns exist above the loaded ones. */
  hasOlder?: boolean;
  onLoadOlder?: () => void;
  /** Changes when the user sends a message, which returns the view to the newest turn to follow it. */
  followKey?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  /** The first turn in view, how far below the top it sat, and the scroll position then. */
  const anchor = useRef<Anchor | null>(null);
  const firstTurn = useRef<string | undefined>(undefined);
  const olderRef = useRef<HTMLDivElement>(null);
  const olderInView = useRef(false);
  const loadOlder = useRef(onLoadOlder);
  loadOlder.current = onLoadOlder;
  // Opening a conversation waits, unseen, until its newest turns fill the view or nothing older is left, so they
  // first appear at the bottom where they belong instead of sliding down as earlier turns arrive above them.
  const [filledKey, setFilledKey] = useState<string | null>(null);
  const waiting = hasOlder && filledKey !== scrollKey;
  const reveal = useRef(() => {});
  reveal.current = () => {
    const el = parentRef.current;
    if (el && waiting && el.scrollHeight > el.clientHeight) setFilledKey(scrollKey);
  };

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    const onScroll = () => {
      const top = el.scrollTop;
      // The browser also moves up to stay in range when the view grows or the content shrinks, such as the
      // composer emptying after a send. That leaves the view at the bottom, so only rising above it lets go.
      if (top < lastScrollTop.current && !atBottom()) pinned.current = false;
      else if (top > lastScrollTop.current && atBottom()) pinned.current = true;
      lastScrollTop.current = top;
      anchor.current = firstTurnInView(el);
    };
    // Input arrives before scroll events. Release the tail before a render or
    // ResizeObserver can undo the first few pixels of an upward gesture.
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pinned.current = false;
      else if (event.deltaY > 0 && atBottom()) pinned.current = true;
    };
    let touchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined && nextY > touchY) pinned.current = false;
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pinned.current = false;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    // Child task cards keep streaming after the parent turn ends. Observe their
    // layout too, including wrapping when the window or composer changes size.
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToTail(el, lastScrollTop);
      reveal.current();
    });
    observer.observe(el, { box: "border-box" });
    if (contentRef.current) observer.observe(contentRef.current, { box: "border-box" });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, []);

  // Follow the tail only while pinned to it; scrolling up hands the transcript to the reader. When older turns load
  // above, the browser keeps the reader's place, except at the very top where it does not; there the turn they were
  // reading is put back where it was. Anything else, such as a turn folding its work, is left to the browser.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>("[data-turn]")?.dataset["turn"];
    const olderArrived = firstTurn.current !== undefined && first !== firstTurn.current;
    firstTurn.current = first;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else if (olderArrived && anchor.current && Math.abs(el.scrollTop - anchor.current.scrollTop) < 1) {
      const turn = el.querySelector(`[data-turn="${CSS.escape(anchor.current.id)}"]`);
      const drift = turn ? turn.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.current.offset : 0;
      if (Math.abs(drift) >= 1) el.scrollTop += drift;
    }
    lastScrollTop.current = el.scrollTop;
    anchor.current = firstTurnInView(el);
    reveal.current();
  }, [run.blocks]);

  // Older turns load a screen before the reader reaches them, and keep loading while the top stays in reach.
  useEffect(() => {
    const el = parentRef.current;
    const older = olderRef.current;
    if (!el || !older) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        olderInView.current = Boolean(entry?.isIntersecting);
        if (olderInView.current) loadOlder.current?.();
      },
      { root: el, rootMargin: "100% 0px 0px 0px" },
    );
    observer.observe(older);
    return () => observer.disconnect();
  }, [hasOlder]);
  useEffect(() => {
    if (hasOlder && olderInView.current) loadOlder.current?.();
  }, [run.blocks, hasOlder]);
  useLayoutEffect(() => {
    pinned.current = true;
    if (parentRef.current) scrollToTail(parentRef.current, lastScrollTop);
  }, [scrollKey, followKey]);
  // Loading that stalls must not keep the conversation hidden; after a moment it shows what it has.
  useEffect(() => {
    const timer = setTimeout(() => setFilledKey(scrollKey), 1500);
    return () => clearTimeout(timer);
  }, [scrollKey]);
  const arrivals = useArrivals(waiting, scrollKey) && (working || run.live);

  return (
    <ThreadMedia scopeKey={scrollKey} basePath={basePath} fileScope={fileScope} mentionNames={mentionNames}>
      <div ref={parentRef} data-transcript data-arrivals={arrivals || undefined} className={cn("h-full overflow-y-auto", waiting && "invisible")}>
        <div ref={contentRef} className="max-w-chat mx-auto px-6 py-5">
          {hasOlder ? <div ref={olderRef} aria-hidden /> : null}
          {children ?? <WorkTranscript runId={run.runId} blocks={run.blocks} live={working || run.live} onFork={onFork} trailing={trailing} />}
          {run.blocks.length > 0 ? <AgentPresence working={working} /> : null}
        </div>
      </div>
    </ThreadMedia>
  );
}

type Anchor = { id: string; offset: number; scrollTop: number };

/** Shows the newest turn, and remembers where so the scroll event this causes is not taken for the reader leaving. */
function scrollToTail(el: HTMLElement, lastScrollTop: RefObject<number>) {
  el.scrollTop = el.scrollHeight;
  lastScrollTop.current = el.scrollTop;
}

/** The first turn whose bottom is below the top of the scroller, found by halving since turns are in order. */
function firstTurnInView(el: HTMLElement): Anchor | null {
  const turns = el.querySelectorAll<HTMLElement>("[data-turn]");
  const top = el.getBoundingClientRect().top;
  let low = 0;
  let high = turns.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (turns[middle]!.getBoundingClientRect().bottom > top) high = middle;
    else low = middle + 1;
  }
  const turn = turns[low];
  return turn ? { id: turn.dataset["turn"]!, offset: turn.getBoundingClientRect().top - top, scrollTop: el.scrollTop } : null;
}

/** True once the conversation has filled and painted: from then on, new blocks arrive rather than appear. */
function useArrivals(waiting: boolean, key: string): boolean {
  const [filled, setFilled] = useState<string | null>(null);
  useEffect(() => {
    if (waiting) return;
    const frame = requestAnimationFrame(() => setFilled(key));
    return () => cancelAnimationFrame(frame);
  }, [waiting, key]);
  return filled === key;
}

/** A run of finished steps reads as one line until opened, the way the agent apps fold their work. */
type Item = { kind: "block"; block: Block } | { kind: "group"; id: string; blocks: Block[] };

export function groupBlocks(blocks: Block[], taskCards = true, pinned?: string, groupTools = true): Item[] {
  const items: Item[] = [];
  let run: Block[] = [];
  const flush = () => {
    const first = run[0];
    // A lone activity or thought already supplies its own label and disclosure.
    // Wrapping it repeats the same row without revealing any new information.
    if (run.length === 1 && first && first.kind !== "tool") items.push({ kind: "block", block: first });
    else if (first) items.push({ kind: "group", id: `group-${first.id}`, blocks: run });
    run = [];
  };
  for (const block of uniqueTaskCards(blocks, taskCards)) {
    if (groupTools && foldable(block, taskCards) && block.id !== pinned) run.push(block);
    else {
      flush();
      items.push({ kind: "block", block });
    }
  }
  flush();
  return items;
}

/** "Edited 3 files, ran 2 commands, read a file": what a folded run of steps did, in the order it did it. */
export function groupSummary(blocks: Block[]): string {
  const counts = new Map<string, number>();
  for (const block of blocks) {
    if (block.kind === "thinking") continue;
    const tool = block.kind === "tool" ? toolCallPresentation(block.name, block.input) : null;
    let key: string;
    if (tool) key = tool.summary ?? tool.verb;
    else if (block.kind === "activity") key = block.label;
    else key = block.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const nouns: Record<string, [string, string]> = { Ran: ["a command", "commands"], Read: ["a file", "files"], Edited: ["a file", "files"], Searched: ["once", "times"], Fetched: ["a page", "pages"] };
  const parts = [...counts.entries()].map(([verb, count]) => {
    const noun = nouns[verb];
    if (!noun) return count === 1 ? verb : `${verb} ×${count}`;
    return `${verb} ${count === 1 ? noun[0] : `${count} ${noun[1]}`}`;
  });
  const [first, ...rest] = parts;
  return [first ?? "Thought", ...rest.map((part) => part.charAt(0).toLowerCase() + part.slice(1))].join(", ");
}

type GroupRowProps = { id: string; blocks: Block[]; runId: string; taskCards: boolean };

/** Grouping builds new arrays each render; a folded group whose blocks are all the same objects has nothing new to show. */
const sameGroup = (a: GroupRowProps, b: GroupRowProps) =>
  a.id === b.id && a.runId === b.runId && a.taskCards === b.taskCards && a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block === b.blocks[i]);

const GroupRow = memo(function GroupRow({ id, blocks, runId, taskCards }: GroupRowProps) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const first = blocks.find((b) => b.kind === "tool") ?? blocks.find((b) => b.kind !== "thinking");
  const { icon: Icon, tone } = first?.kind === "tool" ? toolCallPresentation(first.name, first.input) : { icon: WorkMessage, tone: "neutral" as Tone };
  const live = blocks.some((b) => (b.kind === "tool" && !b.done) || (b.kind === "thinking" && b.endedAt === null) || (b.kind === "activity" && b.status === "running"));
  let label: string;
  if (live && !first) label = "Thinking";
  else if (live && blocks.length === 1 && first?.kind === "tool") label = liveVerb(toolCallPresentation(first.name, first.input).verb);
  else label = groupSummary(blocks);
  const detailId = useId();
  return (
    <div data-transcript-group={id}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => {
          setVisited(true);
          setOpen((v) => !v);
        }}
        className="work-step-toggle"
      >
        {live ? <Loader2 size={16} className="tool-row-live shrink-0" /> : <Icon size={16} className="tool-icon shrink-0" data-tone={tone} />}
        <span className="truncate">{label}</span>
        <ChevronRight size={12} className={cn("work-chevron shrink-0", open && "rotate-90")} />
      </button>
      <div id={detailId} hidden={!open} className="work-step-detail">
        {visited ? blocks.map((block) => <BlockView key={block.id} block={block} runId={runId} taskCards={taskCards} />) : null}
      </div>
    </div>
  );
}, sameGroup);

type WorkTranscriptProps = ComponentProps<typeof TranscriptContents> & {
  live?: boolean;
  ambient?: boolean;
  author?: string | undefined;
  showActivity?: boolean;
  /** Each turn opens with its head: the agent, its model and where it stands. Team turns carry their own author line. */
  head?: boolean;
};
type WorkTurnProps = WorkTranscriptProps & { id?: string; latest?: boolean };

/** The same disclosure hierarchy serves solo turns, warm sessions, and team members. */
export function WorkTranscript({ blocks, live = false, onFork, ...props }: WorkTranscriptProps) {
  const turns = useSteadyTurns(blocks);
  // A fork carries the whole conversation and the agent's latest session, so it is offered only at the latest message.
  const forkTurn = onFork ? turns.findLastIndex((turn) => turn.blocks.some((block) => block.kind === "message" && block.role === "user")) : -1;
  return (
    <>
      {turns.map((turn, index) => (
        <WorkTurn
          key={turn.id}
          id={turn.id}
          {...props}
          onFork={index === forkTurn ? onFork : undefined}
          blocks={turn.blocks}
          live={live && index === turns.length - 1}
          latest={index === turns.length - 1}
        />
      ))}
    </>
  );
}

/**
 * A turn's blocks keep their array while none of them changed, so only the turn being streamed re-renders. A
 * finished turn's blocks are the same objects from frame to frame.
 */
function useSteadyTurns(blocks: Block[]): { id: string; blocks: Block[] }[] {
  const previous = useRef(new Map<string, Block[]>());
  return useMemo(() => {
    const turns = workTurns(blocks);
    const next = new Map<string, Block[]>();
    const steady = turns.map((turn) => {
      const before = previous.current.get(turn.id);
      const same = before && before.length === turn.blocks.length && before.every((block, i) => block === turn.blocks[i]);
      const kept = same ? before : turn.blocks;
      next.set(turn.id, kept);
      return same ? { ...turn, blocks: kept } : turn;
    });
    previous.current = next;
    return steady;
  }, [blocks]);
}

/** Open while the turn runs, folded once it is done, unless the reader chose; a choice resets when activity shows or hides. */
function useWorkOpen(showActivity: boolean, live: boolean) {
  const [choice, setChoice] = useState<{ mode: boolean; open: boolean | null }>({ mode: showActivity, open: null });
  if (choice.mode !== showActivity) setChoice({ mode: showActivity, open: null });
  const open = (choice.mode === showActivity ? choice.open : null) ?? (showActivity && live);
  const visited = useVisited(open);
  return { open, visited, choose: (next: boolean) => setChoice({ mode: showActivity, open: next }) };
}

const WorkTurn = memo(function WorkTurn({ id, blocks, live = false, ambient = false, author: named, trailing, showActivity = true, head = true, latest = false, onFork, ...props }: WorkTurnProps) {
  props = { ...props, runId: blocks.find((b) => b.runId)?.runId ?? props.runId };
  const turn = useTurnModel(blocks, live, props.taskCards, ambient, props.replyAction?.blockId);
  const { before, work, after } = turn.parts;
  const { open, visited, choose } = useWorkOpen(showActivity, turn.live);
  const contentId = useId();
  const ended = turn.status.kind === "failed" || turn.status.kind === "stopped";
  const footer = trailing?.(blocks);
  const hiddenRecovery = !open || !showActivity ? work.findLast((b): b is Extract<Block, { kind: "activity" }> => b.kind === "activity" && Boolean(b.recovery))?.recovery : undefined;
  if (!showActivity && !before.length && !after.length && !ended && !footer) return null;
  const spoke = Boolean(work.length || after.length || turn.live || ended);
  // The fork rides the turn's actions once it has them; until then it stays on the prompt.
  const actions = head && spoke && !turn.live && (turn.reply || onFork);
  return (
    <div className="work-turn" data-turn={id}>
      <TranscriptContents {...props} onFork={actions ? undefined : onFork} blocks={before} />
      {head && spoke ? <TurnHead runId={props.runId} named={named} status={turn.status} /> : null}
      {!head && ended ? <TurnOutcome named={named} runId={props.runId} failed={turn.status.kind === "failed"} /> : null}
      {showActivity && work.length ? (
        <section className="work-section" aria-label={named ? `${named}’s work` : "Agent work"}>
          <TurnReceipt items={turn.receipt} open={open} controls={contentId} onToggle={() => choose(!open)} />
          {!open && turn.live ? <WorkNow blocks={work} turn={blocks} taskCards={props.taskCards} /> : null}
          <div
            id={contentId}
            hidden={!open}
            className="work-content motion-collapse"
            onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest("button, summary")) choose(true);
            }}
          >
            {open || visited ? (
              <WorkSteps
                blocks={work}
                turn={blocks}
                live={turn.live}
                taskCards={props.taskCards}
                pinned={props.replyAction?.blockId}
                renderBlocks={(items, openTools) => <TranscriptContents {...props} blocks={items} groupTools={false} openTools={openTools} />}
              />
            ) : null}
          </div>
        </section>
      ) : null}
      {hiddenRecovery ? <Recovery recovery={hiddenRecovery} folded /> : null}
      <TranscriptContents {...props} blocks={after} replyActions={!head} />
      {footer}
      {actions ? <TurnActions text={turn.reply?.text} at={turn.reply?.at} onFork={onFork} resting={latest} /> : null}
    </div>
  );
});

/** A team turn has its own author line; a failed or stopped one still says so. */
function TurnOutcome({ named, runId, failed }: { named: string | undefined; runId: string; failed: boolean }) {
  const author = useTurnAuthor(named, runId);
  return (
    <p className="turn-outcome" role="status">
      {author ? `${author} · ` : ""}
      {failed ? "Failed" : "Stopped"}
    </p>
  );
}

/** Shared event rendering keeps approvals and media attached to their actual run. */
export function TranscriptContents({
  runId,
  blocks,
  onFork,
  replyAction,
  trailing,
  taskCards = true,
  groupTools = true,
  pendingApproval,
  openTools = false,
  replyActions = true,
}: {
  runId: string;
  blocks: Block[];
  onFork?: (() => void) | undefined;
  replyAction?: { blockId: string; content: ReactNode } | undefined;
  /** Content that follows a block or a folded group of blocks, such as a turn's change card. */ trailing?: ((blocks: Block[]) => ReactNode) | undefined;
  taskCards?: boolean;
  groupTools?: boolean;
  pendingApproval?: ((block: Extract<Block, { kind: "approval" }>) => ReactNode) | undefined;
  /** Tool calls start open, for a call the reader picked from the work list. */
  openTools?: boolean;
  /** Replies carry their own copy and time; a turn that ends in its actions row passes false. */
  replyActions?: boolean;
}) {
  const items: Item[] = useMemo(() => groupBlocks(blocks, taskCards, replyAction?.blockId, groupTools), [blocks, taskCards, replyAction?.blockId, groupTools]);
  const compact = (item: Item | undefined) => Boolean(item && (item.kind === "group" || isCompact(item.block)));
  return (
    <>
      {items.map((item, i) =>
        item.kind === "group" ? (
          <div key={item.id} className={cn("transcript-block", compact(items[i - 1]) ? "mt-0" : "mt-3")}>
            <GroupRow id={item.id} blocks={item.blocks} runId={runId} taskCards={taskCards} />
            {trailing?.(item.blocks)}
          </div>
        ) : (
          <div key={item.block.id} className={cn("transcript-block", isCompact(item.block) && compact(items[i - 1]) ? "mt-0" : "mt-3")}>
            {item.block.kind === "approval" && !item.block.decision && pendingApproval ? (
              pendingApproval(item.block)
            ) : (
              <BlockView block={item.block} runId={runId} onFork={onFork} taskCards={taskCards} openTools={openTools} actions={replyActions} />
            )}
            {replyAction?.blockId === item.block.id ? replyAction.content : null}
            {trailing?.([item.block])}
          </div>
        ),
      )}
    </>
  );
}

function isCompact(block: Block | undefined): boolean {
  return Boolean(block && (block.kind === "tool" || block.kind === "thinking" || block.kind === "activity" || block.kind === "status" || (block.kind === "approval" && Boolean(block.decision))));
}

/** One object for every message, so the rich-text memo holds while another row streams. */
const wordFade = { animation: "fadeIn", sep: "word", duration: 240 } as const;

/** A reply as prose, with its copy and time under it unless the turn's actions row carries them. */
function ReplyMessage({ block, actions }: { block: Extract<Block, { kind: "message" }>; actions: boolean }) {
  if (block.streaming && !block.text)
    return (
      <div data-state="running" className="reply-pending" role="status">
        <span className="reply-pulse" aria-hidden="true" />
        Writing response
      </div>
    );
  return (
    <div className="group journal-message journal-response">
      <div className="text-prose text-ink prose-chat">
        <ThreadRichText mode="streaming" isAnimating={block.streaming} animated={wordFade}>
          {block.text}
        </ThreadRichText>
      </div>
      {actions ? (
        <div className="journal-reply-actions">
          {block.text ? <CopyMessage text={block.text} /> : null}
          {block.streaming ? null : <MessageTime at={block.at} />}
        </div>
      ) : null}
    </div>
  );
}

const BlockView = memo(function BlockView({
  block,
  runId,
  onFork,
  taskCards,
  openTools = false,
  actions = true,
}: {
  block: Block;
  runId: string;
  onFork?: (() => void) | undefined;
  taskCards: boolean;
  openTools?: boolean;
  actions?: boolean;
}) {
  switch (block.kind) {
    case "message":
      if (block.role === "user") return <UserMessage text={block.text} at={block.at} attachments={block.attachments} onFork={onFork} />;
      if (block.role === "system")
        return (
          <div>
            <SystemNotice text={block.text} />
            {block.attachments?.map((path) => (
              <ThreadImage key={path} src={`openorc-asset://attachments/${path.split("/").pop() ?? ""}`} alt="Slack participant image" compact />
            ))}
          </div>
        );
      if (/^API Error:/.test(block.text)) return <TranscriptErrorCard text={block.text} />;
      return <ReplyMessage block={block} actions={actions} />;
    case "activity":
      if (isImageView(block)) return <ImageViewRow block={block} />;
      return isImageGeneration(block) ? <ImageGenerationRow block={block} /> : <ActivityRow block={block} />;
    case "thinking":
      return <ThinkingRow block={block} />;
    case "tool":
      return <ToolBlock block={block} cards={taskCards} open={openTools} />;
    case "approval":
      return block.approvalKind === "user_input" ? (
        <QuestionCard runId={runId} approvalId={block.approvalId} input={block.input} decided={block.decision} answers={block.answers} />
      ) : (
        <ApprovalCard block={block} runId={runId} />
      );
    case "status":
      // "turn error" and "session error" restate the error card above them.
      return block.tone === "bad" && !/^(turn|session) /.test(block.text) ? <TranscriptErrorCard text={block.text} /> : null;
  }
});

function UserMessage({ text, at, attachments, onFork }: { text: string; at?: number | undefined; attachments?: string[]; onFork?: (() => void) | undefined }) {
  return (
    <div className="group journal-message journal-prompt">
      <div className="journal-message-body grid gap-2">
        {attachments && attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 justify-end">
            {attachments.map((a) =>
              isImagePath(a) ? <ThreadImage key={a} src={`openorc-asset://attachments/${a.split("/").pop() ?? ""}`} alt="Attached image" compact /> : <AttachedFile key={a} path={a} />,
            )}
          </div>
        ) : null}
        <div className="message-bubble text-prose whitespace-pre-wrap">{text}</div>
        <div className="journal-message-actions">
          {text ? <CopyMessage text={text} /> : null}
          {onFork ? <ForkButton onFork={onFork} /> : null}
          <MessageTime at={at} />
        </div>
      </div>
    </div>
  );
}

function ForkButton({ onFork }: { onFork: () => void }) {
  return (
    <IconButton size="md" onClick={() => onFork()} title="Continue this conversation in a new thread" aria-label="Fork thread" className="message-action">
      <GitFork size={16} />
    </IconButton>
  );
}

/**
 * An attachment with nothing to preview. The stored name keeps the one the
 * user gave it after the id that makes it unique, so the chip prints that and
 * opens the file where it lives.
 */
function AttachedFile({ path }: { path: string }) {
  const stored = path.split(/[\\/]/).pop() ?? path;
  const name = /^[a-f0-9-]{36}-/.test(stored) ? stored.slice(37) : stored;
  return (
    <button type="button" onClick={() => window.openorc.revealFile(path)} title={`Show in folder: ${path}`} className="attached-file">
      <FileText size={16} className="shrink-0 text-ink-4" />
      <span className="truncate">{name}</span>
    </button>
  );
}

/** A tool call that saved or started work shows that work as a live card; any other call is a row. */
function ToolBlock({ block, cards, open = false }: { block: Extract<Block, { kind: "tool" }>; cards: boolean; open?: boolean }) {
  const taskId = cards ? taskIdFromTool(block) : null;
  if (taskId) return <TaskCard taskId={taskId} />;
  const started = cards ? startedWorkFromTool(block) : null;
  return started ? <StartedThreadCard threadId={started.threadId} /> : <ToolRow block={block} defaultOpen={open} />;
}

function activityStatus(block: Extract<Block, { kind: "activity" }>, live: boolean): ReactNode {
  if (live) return <Loader2 size={14} className="tool-row-live" />;
  if (block.status !== "success") return <span className="text-xs">{stateLabel(block.status)}</span>;
  return null;
}

/** The hue an activity's icon takes from what it is. */
function activityTone(label: string): Tone {
  if (/compact/i.test(label)) return "context";
  if (/plan/i.test(label)) return "plan";
  if (/starting|waiting/i.test(label)) return "neutral";
  return "task";
}

function ActivityRow({ block }: { block: Extract<Block, { kind: "activity" }> }) {
  const [open, setOpen] = useState(false);
  const live = block.status === "running";
  const showText = Boolean(block.text && (live || open || block.status === "error"));
  const patch = showText && ((block.label === "Changes" && block.id.startsWith("activity-diff-")) || isUnifiedDiff(block.text));
  const expandable = Boolean(block.text || block.detail);
  return (
    <div>
      <button
        data-state={block.status}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn("tool-row", block.status === "error" && "text-bad")}
      >
        {block.status === "success" && /agent|finished|completed/i.test(block.label) ? (
          <WorkAgent size={16} className="tool-icon shrink-0" data-tone="agent" />
        ) : (
          <WorkMessage size={16} className="tool-icon shrink-0" data-tone={block.status === "error" ? "error" : activityTone(block.label)} />
        )}
        <span>{block.label}</span>
        {activityStatus(block, live)}
        {expandable ? <ChevronRight size={12} className={cn("tool-row-chevron", open && "rotate-90")} /> : null}
      </button>
      {showText &&
        (patch ? (
          <div className="tool-row-detail">
            <Suspense fallback={diffLoading}>
              <InlineDiff patch={block.text} />
            </Suspense>
          </div>
        ) : (
          <div className="tool-row-text">{block.text}</div>
        ))}
      {block.recovery ? <Recovery recovery={block.recovery} className="tool-row-detail" /> : null}
      {open && block.detail !== undefined ? <pre className="tool-row-detail tool-row-raw">{pretty(block.detail, Infinity)}</pre> : null}
    </div>
  );
}

/** The way back from a failed activity, on its row, or under the folded work with what happened. */
function Recovery({ recovery, folded = false, className }: { recovery: ActivityRecovery; folded?: boolean; className?: string }) {
  if (recovery.kind === "sign_in")
    return <SignInRecovery provider={recovery.provider} lead={folded ? `${harnessCatalog[recovery.provider].shortName} is signed out.` : undefined} className={className} />;
  return <UsageRecovery provider={recovery.provider} lead={folded ? "Usage limit reached." : undefined} className={className} />;
}

/** "Thought for 12 seconds", or "Thinking" while it runs. */
function thoughtWords(block: Extract<Block, { kind: "thinking" }>): string {
  if (block.endedAt === null) return "Thinking";
  const seconds = Math.max(1, Math.round((block.endedAt - block.startedAt) / 1000));
  const time = seconds < 60 ? `${seconds} ${seconds === 1 ? "second" : "seconds"}` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const ended = block.status && block.status !== "success" ? ` · ${stateLabel(block.status)}` : "";
  return `Thought for ${time}${ended}`;
}

/**
 * How long the agent reasoned, opened on demand: the reasoning grows open under a thin rule, its paragraphs
 * arriving one after another. Claude Code often sends the block with no text; that line then has nothing to unfold.
 */
function ThinkingRow({ block }: { block: Extract<Block, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const live = block.endedAt === null;
  const text = block.text.trim();
  const bodyId = useId();
  return (
    <div className="thinking">
      <button
        type="button"
        data-state={live ? "running" : (block.status ?? "success")}
        aria-expanded={text ? open : undefined}
        aria-controls={text ? bodyId : undefined}
        onClick={() => setOpen((v) => !v)}
        disabled={!text}
        className="thinking-head"
      >
        {live ? <Loader2 size={16} className="tool-row-live" /> : <Lightbulb size={16} />}
        <span>{thoughtWords(block)}</span>
        {text ? <ChevronDown size={14} className={cn("thinking-chevron", open && "rotate-180")} /> : null}
      </button>
      {text && open ? <ThinkingBody id={bodyId} text={text} /> : null}
    </div>
  );
}

function ThinkingBody({ id, text }: { id: string; text: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  return (
    <div id={id} className="thinking-body">
      <div className="thinking-lines motion-stagger">
        {paragraphs.map((paragraph, index) => (
          <p key={index} className="motion-arrive">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );
}

/** OpenOrc talking in the thread: a task result, a hand-off. Not the user, not the agent. */
function SystemNotice({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [head, ...rest] = text.split("\n");
  const details = rest.join("\n").trim();
  return (
    <div className="system-notice">
      <WorkMessage size={16} className="system-notice-icon" />
      <div className="min-w-0 flex-1">
        <div className="text-ink-2">{head}</div>
        {details ? (
          <>
            {open ? <pre className="system-notice-details">{details}</pre> : null}
            <TextButton tone="faint" onClick={() => setOpen((v) => !v)} className="mt-1 text-sm">
              {open ? "Hide details" : "Show details"}
            </TextButton>
          </>
        ) : null}
      </div>
    </div>
  );
}
