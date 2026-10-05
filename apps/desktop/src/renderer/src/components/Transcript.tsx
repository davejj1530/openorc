import { lazy, memo, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps, type RefObject } from "react";
import { harnessCatalog, type ActivityRecovery } from "@openorc/protocol";
import { WorkMessage, WorkAgent, WorkLive, Check, ChevronRight, FileText, GitFork, X } from "./icons";
import { workTurns, workParts, workTiming, workDuration } from "../lib/work-transcript";
import { cn } from "../lib/cn";
import { core } from "../lib/rpc";
import type { FileSelection } from "../lib/layout";
import type { Block, RunTranscript } from "../lib/transcript";
import { QuestionCard } from "./QuestionCard";
import { AgentPresence } from "./AgentPresence";
import { useTurnAuthor } from "../lib/turn-authors";
import { toolCallPresentation, type Tone } from "./tool-presentation";
import { foldable } from "./work-steps";
import { WorkNow, WorkSteps } from "./WorkSteps";
import { turnReceipt } from "./work-receipt";
export { AgentPresence } from "./AgentPresence";
import { StartedThreadCard } from "./StartedThreadCard";
import { TaskCard } from "./TaskCard";
import { startedWorkFromTool, taskIdFromTool, uniqueTaskCards } from "../lib/task-progress";
import { ToolResult } from "./ToolResult";
import { UsageRecovery } from "./UsageRecovery";
import { SignInRecovery } from "./SignInRecovery";
import { TranscriptErrorCard } from "./TranscriptErrorCard";
const McpAppResult = lazy(() => import("./McpAppResult"));
import { Button, IconButton, TextButton } from "./ui";
import { ImageGenerationRow, ImageViewRow, ThreadImage, ThreadMedia, ThreadRichText } from "./ThreadImages";
import { isImageGeneration, isImageView } from "../lib/image-activity";
import { isUnifiedDiff, toolDiff } from "../lib/chat-diff";
import { isImagePath } from "../../../shared/image-paths";
import { CopyMessage, MessageTime } from "./MessageActions";

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
  onFork?: (runId: string) => void;
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

  return (
    <ThreadMedia scopeKey={scrollKey} basePath={basePath} fileScope={fileScope} mentionNames={mentionNames}>
      <div ref={parentRef} data-transcript className={cn("h-full overflow-y-auto", waiting && "invisible")}>
        <div ref={contentRef} className="max-w-chat mx-auto px-6 py-5">
          {hasOlder ? <div ref={olderRef} aria-hidden /> : null}
          {children ?? <WorkTranscript runId={run.runId} blocks={run.blocks} live={working || run.live} onFork={onFork} trailing={trailing} />}
          {run.blocks.length > 0 ? <AgentPresence working={working} since={lastPromptAt(run.blocks)} showElapsed={Boolean(children)} /> : null}
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

function lastPromptAt(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind === "message" && block.role === "user" && block.at) return block.at;
  }
  return Date.now();
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
        {live ? <WorkLive size={16} className="work-live shrink-0" /> : <Icon size={16} className="tool-icon shrink-0" data-tone={tone} />}
        <span className="truncate">{label}</span>
        <ChevronRight size={12} className={cn("work-chevron shrink-0", open && "rotate-90")} />
      </button>
      <div id={detailId} hidden={!open} className="work-step-detail">
        {visited ? blocks.map((block) => <BlockView key={block.id} block={block} runId={runId} taskCards={taskCards} />) : null}
      </div>
    </div>
  );
}, sameGroup);

type WorkTranscriptProps = ComponentProps<typeof TranscriptContents> & { live?: boolean; ambient?: boolean; author?: string | undefined; showActivity?: boolean };
type WorkTurnProps = WorkTranscriptProps & { id?: string };

/** The same disclosure hierarchy serves solo turns, warm sessions, and team members. */
export function WorkTranscript({ blocks, live = false, ...props }: WorkTranscriptProps) {
  const turns = useSteadyTurns(blocks);
  return (
    <>
      {turns.map((turn, index) => (
        <WorkTurn key={turn.id} id={turn.id} {...props} blocks={turn.blocks} live={live && index === turns.length - 1} />
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

const WorkTurn = memo(function WorkTurn({ id, blocks, live = false, ambient = false, author: named, trailing, showActivity = true, ...props }: WorkTurnProps) {
  props = { ...props, runId: blocks.find((b) => b.runId)?.runId ?? props.runId };
  const author = useTurnAuthor(named, props.runId);
  const timing = workTiming(blocks, live);
  const { before, work, after } = workParts(blocks, timing.live, props.taskCards, ambient);
  const [choice, setChoice] = useState<{ mode: boolean; open: boolean | null }>({ mode: showActivity, open: null });
  if (choice.mode !== showActivity) setChoice({ mode: showActivity, open: null });
  const open = (choice.mode === showActivity ? choice.open : null) ?? (showActivity && timing.live);
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (open) setVisited(true);
  }, [open]);
  const contentId = useId();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timing.live || !showActivity) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timing.live, showActivity]);
  const elapsed = timing.live && timing.startedAt !== undefined ? Math.max(0, now - timing.startedAt) : timing.durationMs;
  let outcome: string | null = null;
  if (timing.outcome === "error") outcome = "Failed";
  else if (timing.outcome === "cancelled") outcome = "Stopped";
  // A finished turn says what it came to: "Worked for 4m · 2 files changed · tests passed".
  const receipt = timing.live ? [] : turnReceipt(blocks);
  const label = timing.live
    ? `Working${elapsed === undefined ? "" : ` · ${workDuration(elapsed)}`}`
    : [`${outcome ?? "Worked"}${elapsed === undefined ? "" : ` for ${workDuration(elapsed)}`}`, ...receipt].join(" · ");
  // Even a tool-free failed turn needs a terminal status; never leave it saying Working.
  const hasWork = work.length > 0 || Boolean(outcome);
  const footer = trailing?.(blocks);
  const hiddenRecovery = !open || !showActivity ? work.findLast((b): b is Extract<Block, { kind: "activity" }> => b.kind === "activity" && Boolean(b.recovery))?.recovery : undefined;
  if (!showActivity && !before.length && !after.length && !outcome && !footer) return null;
  return (
    <div className="work-turn" data-turn={id}>
      <TranscriptContents {...props} blocks={before} />
      {!showActivity && outcome ? (
        <p className="my-4 text-sm text-ink-3" role="status">
          {author ? `${author} · ` : ""}
          {label}
        </p>
      ) : null}
      {showActivity && hasWork ? (
        <section className="work-section" aria-label={author ? `${author}’s work` : "Agent work"}>
          <button type="button" className="work-toggle" aria-expanded={open} aria-controls={contentId} onClick={() => setChoice({ mode: showActivity, open: !open })}>
            <span>
              {author ? `${author} · ` : ""}
              {label}
            </span>
            <ChevronRight size={14} className={cn("work-chevron", open && "rotate-90")} />
          </button>
          {!open && timing.live && showActivity ? <WorkNow blocks={work} turn={blocks} taskCards={props.taskCards} /> : null}
          <div
            id={contentId}
            hidden={!open}
            className="work-content"
            onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest("button, summary")) setChoice({ mode: showActivity, open: true });
            }}
          >
            {open || visited ? (
              <WorkSteps
                blocks={work}
                turn={blocks}
                live={timing.live}
                taskCards={props.taskCards}
                pinned={props.replyAction?.blockId}
                renderBlocks={(items, openTools) => <TranscriptContents {...props} blocks={items} groupTools={false} openTools={openTools} />}
              />
            ) : null}
          </div>
        </section>
      ) : null}
      {hiddenRecovery ? <Recovery recovery={hiddenRecovery} folded /> : null}
      <TranscriptContents {...props} blocks={after} />
      {footer}
    </div>
  );
});

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
}: {
  runId: string;
  blocks: Block[];
  onFork?: ((runId: string) => void) | undefined;
  replyAction?: { blockId: string; content: ReactNode } | undefined;
  /** Content that follows a block or a folded group of blocks, such as a turn's change card. */ trailing?: ((blocks: Block[]) => ReactNode) | undefined;
  taskCards?: boolean;
  groupTools?: boolean;
  pendingApproval?: ((block: Extract<Block, { kind: "approval" }>) => ReactNode) | undefined;
  /** Tool calls start open, for a call the reader picked from the work list. */
  openTools?: boolean;
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
              <BlockView block={item.block} runId={runId} onFork={onFork} taskCards={taskCards} openTools={openTools} />
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

const BlockView = memo(function BlockView({
  block,
  runId,
  onFork,
  taskCards,
  openTools = false,
}: {
  block: Block;
  runId: string;
  onFork?: ((runId: string) => void) | undefined;
  taskCards: boolean;
  openTools?: boolean;
}) {
  const author = useTurnAuthor(undefined, block.runId ?? runId);
  switch (block.kind) {
    case "message":
      if (block.role === "user")
        return <UserMessage text={block.text} at={block.at} attachments={block.attachments} onFork={onFork && block.runId ? () => onFork(block.runId as string) : undefined} />;
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
      if (block.streaming && !block.text)
        return (
          <div data-state="running" className="text-sm text-ink-3 animate-pulse">
            Writing response
          </div>
        );
      return (
        <div className="group journal-message journal-response">
          <div className="journal-author">
            <span className="journal-author-mark" />
            {author ?? "Assistant"}
          </div>
          <div className="text-prose text-ink prose-chat">
            <ThreadRichText mode="streaming" isAnimating={block.streaming} animated={wordFade}>
              {block.text}
            </ThreadRichText>
          </div>
          <div className="journal-reply-actions mt-1 flex min-h-5 items-center gap-2">
            {block.streaming ? null : <MessageTime at={block.at} />}
            {block.text ? <CopyMessage text={block.text} /> : null}
          </div>
        </div>
      );
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
        <ApprovalRow block={block} runId={runId} />
      );
    case "status":
      // "turn error" and "session error" restate the error card above them.
      return block.tone === "bad" && !/^(turn|session) /.test(block.text) ? <TranscriptErrorCard text={block.text} /> : null;
  }
});

function UserMessage({ text, at, attachments, onFork }: { text: string; at?: number | undefined; attachments?: string[]; onFork?: (() => void) | undefined }) {
  return (
    <div className="group journal-message journal-prompt">
      <div className="journal-author">
        <span className="journal-author-mark" />
        You
      </div>
      <div className="journal-message-body grid gap-2">
        {attachments && attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 justify-end">
            {attachments.map((a) =>
              isImagePath(a) ? <ThreadImage key={a} src={`openorc-asset://attachments/${a.split("/").pop() ?? ""}`} alt="Attached image" compact /> : <AttachedFile key={a} path={a} />,
            )}
          </div>
        ) : null}
        <div className="message-bubble text-prose whitespace-pre-wrap">{text}</div>
        <div className="journal-message-actions flex w-full min-h-6 items-center gap-2">
          {text ? <CopyMessage text={text} /> : null}
          {onFork ? (
            <IconButton
              size="sm"
              onClick={onFork}
              title="Fork the thread from this point"
              aria-label="Fork from here"
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
            >
              <GitFork size={13} />
            </IconButton>
          ) : null}
          <MessageTime at={at} />
        </div>
      </div>
    </div>
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
    <button
      type="button"
      onClick={() => window.openorc.revealFile(path)}
      title={`Show in folder: ${path}`}
      className="flex max-w-56 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 hover:border-line-strong hover:text-ink"
    >
      <FileText size={14} className="shrink-0 text-ink-3" />
      <span className="truncate">{name}</span>
    </button>
  );
}

/** One muted line per step, the way the agent apps read: verb, object, state. Click for the raw call. */
function liveVerb(verb: string): string {
  return (
    (
      {
        Ran: "Running command",
        Read: "Reading files",
        Edited: "Editing files",
        Searched: "Searching",
        Fetched: "Fetching",
        Delegated: "Delegating",
        "Sent message": "Sending message",
      } as Record<string, string>
    )[verb] ?? verb
  );
}

/** A tool call that saved or started work shows that work as a live card; any other call is a row. */
function ToolBlock({ block, cards, open = false }: { block: Extract<Block, { kind: "tool" }>; cards: boolean; open?: boolean }) {
  const taskId = cards ? taskIdFromTool(block) : null;
  if (taskId) return <TaskCard taskId={taskId} />;
  const started = cards ? startedWorkFromTool(block) : null;
  return started ? <StartedThreadCard threadId={started.threadId} /> : <ToolRow block={block} defaultOpen={open} />;
}

function ToolRow({ block, defaultOpen = false }: { block: Extract<Block, { kind: "tool" }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // An output left out of the page starts loading when the pointer reaches the row, so it is there by the click.
  const [near, setNear] = useState(false);
  const output = useToolOutput(block, open || near);
  const patch = useMemo(() => (open && /(?:^|__)apply_patch$/.test(block.name) ? toolDiff(block.input) : null), [open, block.name, block.input]);
  const { icon: Icon, verb, object, tone } = toolCallPresentation(block.name, block.input);
  const label = block.done ? verb : liveVerb(verb);
  return (
    <div>
      <button
        aria-expanded={open}
        data-state={block.done ? (block.status ?? (block.isError ? "error" : "success")) : "running"}
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={block.outputOmitted ? () => setNear(true) : undefined}
        onFocus={block.outputOmitted ? () => setNear(true) : undefined}
        className={cn("group flex items-center gap-2 min-h-6 w-full text-left text-sm", block.isError ? "text-bad" : "text-ink-3 hover:text-ink-2")}
      >
        <Icon size={16} className="tool-icon shrink-0" data-tone={block.isError ? "error" : tone} />
        <span className="shrink-0">{label}</span>
        {object ? <span className="font-mono truncate text-ink-2 group-hover:text-ink">{object}</span> : null}
        {block.done && (block.isError || (block.status && block.status !== "success")) ? <span className="text-xs">{stateLabel(block.status ?? "error")}</span> : null}
        {!block.done ? <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" /> : null}
        <ChevronRight size={12} className={cn("ml-auto shrink-0 opacity-0 group-hover:opacity-100 transition-transform", open && "rotate-90 opacity-100")} />
      </button>
      {block.progress ? <div className="ml-5 text-xs text-ink-3 whitespace-pre-wrap">{block.progress}</div> : null}
      {block.mcp && block.done && block.runId ? (
        <Suspense fallback={null}>
          <McpAppResult runId={block.runId} toolCallId={block.id} />
        </Suspense>
      ) : null}
      {open ? (
        <div className="ml-5 min-w-0">
          {patch ? (
            <Suspense fallback={diffLoading}>
              <InlineDiff patch={patch} />
            </Suspense>
          ) : null}
          <div className="tool-detail my-1 rounded-lg border border-line bg-surface-2/50 text-xs grid min-w-0">
            {patch ? (
              <details>
                <summary className="cursor-pointer px-3 py-2 text-ink-3">Tool details</summary>
                <pre className="px-3 py-2 whitespace-pre-wrap break-words text-ink-2 max-h-60 overflow-auto">{pretty(block.input, Infinity)}</pre>
              </details>
            ) : (
              <pre className="px-3 py-2 whitespace-pre-wrap break-words text-ink-2 max-h-60 overflow-auto">{pretty(block.input, Infinity)}</pre>
            )}
            {output !== undefined ? <ToolResult output={output} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A loaded page leaves large outputs out; a row about to open reads its output from the ledger. */
function useToolOutput(block: Extract<Block, { kind: "tool" }>, open: boolean): unknown {
  const [loaded, setLoaded] = useState<{ id: string; output: unknown } | null>(null);
  const { outputOmitted, runId, id } = block;
  const have = loaded?.id === id;
  useEffect(() => {
    if (!open || !outputOmitted || !runId || have) return;
    let current = true;
    core.call("events.toolOutput", { runId, toolCallId: id }).then(
      (result) => current && setLoaded({ id, output: result.output ?? undefined }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [open, outputOmitted, runId, id, have]);
  if (!outputOmitted) return block.output;
  return have ? loaded.output : undefined;
}

function stateLabel(status: string): string {
  return ({ success: "Completed", error: "Failed", cancelled: "Interrupted", disconnected: "Disconnected", running: "Running" } as Record<string, string>)[status] ?? status;
}

function activityStatus(block: Extract<Block, { kind: "activity" }>, live: boolean): ReactNode {
  if (live) return <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />;
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
        className={cn("group flex items-center gap-2 min-h-6 w-full text-left text-sm", block.status === "error" ? "text-bad" : "text-ink-3")}
      >
        {block.status === "success" && /agent|finished|completed/i.test(block.label) ? (
          <WorkAgent size={16} className="tool-icon shrink-0" data-tone="agent" />
        ) : (
          <WorkMessage size={16} className="tool-icon shrink-0" data-tone={block.status === "error" ? "error" : activityTone(block.label)} />
        )}
        <span>{block.label}</span>
        {activityStatus(block, live)}
        {expandable ? <ChevronRight size={12} className={cn("ml-auto transition-transform", open && "rotate-90")} /> : null}
      </button>
      {showText &&
        (patch ? (
          <div className="ml-5 min-w-0">
            <Suspense fallback={diffLoading}>
              <InlineDiff patch={block.text} />
            </Suspense>
          </div>
        ) : (
          <div className="ml-5 my-1 text-sm text-ink-3 whitespace-pre-wrap">{block.text}</div>
        ))}
      {block.recovery ? <Recovery recovery={block.recovery} className="ml-5 my-1" /> : null}
      {open && block.detail !== undefined ? (
        <pre className="ml-5 my-1 px-3 py-2 rounded-lg border border-line text-xs text-ink-3 whitespace-pre-wrap break-words max-h-72 overflow-auto">{pretty(block.detail, Infinity)}</pre>
      ) : null}
    </div>
  );
}

/** The way back from a failed activity, on its row, or under the folded work with what happened. */
function Recovery({ recovery, folded = false, className }: { recovery: ActivityRecovery; folded?: boolean; className?: string }) {
  if (recovery.kind === "sign_in")
    return <SignInRecovery provider={recovery.provider} lead={folded ? `${harnessCatalog[recovery.provider].shortName} is signed out.` : undefined} className={className} />;
  return <UsageRecovery provider={recovery.provider} lead={folded ? "Usage limit reached." : undefined} className={className} />;
}

/**
 * Reasoning reads live while the agent thinks, as in Codex and Claude
 * Desktop, then folds to one line. Claude Code often sends the block with
 * no text; that line then has nothing to unfold.
 */
function ThinkingRow({ block }: { block: Extract<Block, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const live = block.endedAt === null;
  const seconds = Math.max(1, Math.round(((block.endedAt ?? Date.now()) - block.startedAt) / 1000));
  const text = block.text.trim();
  const expandable = text.length > 0;
  return (
    <div>
      <button
        data-state={live ? "running" : (block.status ?? "success")}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        disabled={!expandable}
        className={cn("group flex items-center gap-2 min-h-6 text-sm text-ink-3", expandable && "hover:text-ink-2")}
      >
        <WorkMessage size={16} className="tool-icon shrink-0" />
        <span>{live ? "Thinking" : `Thought for ${seconds}s${block.status && block.status !== "success" ? ` · ${stateLabel(block.status)}` : ""}`}</span>
        {live ? <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" /> : null}
        {expandable ? <ChevronRight size={12} className={cn("opacity-0 group-hover:opacity-100 transition-transform", open && "rotate-90 opacity-100")} /> : null}
      </button>
      {text && open ? <div className={cn("ml-5 my-1 text-sm text-ink-3 whitespace-pre-wrap", live && !open && "thinking-tail")}>{text}</div> : null}
    </div>
  );
}

/**
 * What the user actually needs to judge, per approval shape: the command for
 * shell approvals, the tool arguments for MCP calls, the tool input for
 * Claude's permission prompt. Raw params stay one click away.
 */
function approvalDetail(block: Extract<Block, { kind: "approval" }>): unknown {
  const p = (block.input ?? {}) as Record<string, unknown>;
  if (typeof p["command"] === "string") return p["command"];
  const meta = p["_meta"] as Record<string, unknown> | undefined;
  if (meta && meta["tool_params"] !== undefined) return meta["tool_params"];
  if (p["permissions"] !== undefined) return p["permissions"];
  if (p["input"] !== undefined) return p["input"];
  return block.input;
}

function ApprovalRow({ block, runId }: { block: Extract<Block, { kind: "approval" }>; runId: string }) {
  const decide = (decision: "allow" | "allow_for_run" | "deny") => void core.call("approvals.resolve", { runId, approvalId: block.approvalId, decision });
  const [open, setOpen] = useState(false);
  const label = block.toolName ?? block.approvalKind;
  // An allowed call already shows as its tool row; only a refusal is worth a line of its own.
  if (block.decision && block.decision !== "deny") return null;
  if (block.decision) {
    return (
      <button onClick={() => setOpen((v) => !v)} className="group flex items-center gap-2 min-h-6 w-full text-left text-sm text-ink-3 hover:text-ink-2">
        {block.decision === "deny" ? <X size={13} className="text-bad shrink-0" /> : <Check size={13} className="text-ok shrink-0" />}
        <span>{block.decision === "deny" ? "Denied" : "Allowed"}</span>
        <span className="font-mono truncate text-ink-2">{label}</span>
        {open ? <pre className="basis-full text-xs whitespace-pre-wrap break-words ml-5">{summaryText(approvalDetail(block))}</pre> : null}
      </button>
    );
  }
  return (
    <div data-blocking="true" className="rounded-xl border border-warn/60 bg-warn-soft/30 px-4 py-3">
      <div className="flex items-center gap-2 text-base">
        <span className="font-medium">Allow</span>
        <span className="font-mono text-ink-2 truncate">{label}</span>
        <span className="text-ink-3">?</span>
      </div>
      {block.reason ? <div className="text-sm text-ink-2 mt-1">{block.reason}</div> : null}
      <pre className="text-xs font-mono text-ink-3 whitespace-pre-wrap break-words mt-2 max-h-40 overflow-auto">{open ? pretty(block.input, 800) : summaryText(approvalDetail(block))}</pre>
      <div className="flex items-center gap-2 mt-3">
        <Button size="sm" variant="primary" onClick={() => decide("allow")}>
          Allow
        </Button>
        <Button size="sm" onClick={() => decide("allow_for_run")}>
          Allow for this run
        </Button>
        <Button size="sm" variant="danger" onClick={() => decide("deny")}>
          Deny
        </Button>
        <TextButton onClick={() => setOpen((v) => !v)} className="ml-auto text-xs text-ink-4 hover:text-ink-2">
          {open ? "Summary" : "Raw request"}
        </TextButton>
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
    <div className="system-notice rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
      <div className="flex items-start gap-2">
        <WorkMessage size={16} className="text-ink-3 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-ink-2">{head}</div>
          {details ? (
            <>
              {open ? <pre className="mt-1 whitespace-pre-wrap break-words text-ink-3 font-sans">{details}</pre> : null}
              <TextButton onClick={() => setOpen((v) => !v)} className="text-xs text-ink-4 hover:text-ink-2 mt-1">
                {open ? "Hide details" : "Show details"}
              </TextButton>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function summaryText(v: unknown): string {
  if (v === null || v === undefined) return "no arguments";
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "no arguments";
  return pretty(v, 600);
}

function pretty(v: unknown, max = 2000): string {
  const s = typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
