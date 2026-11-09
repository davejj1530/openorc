import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Reaction, reactionEmoji, type MessageReaction, type Orcling } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { useReducedMotion } from "../lib/motion";
import { chatRows, stretchTime, typingBeat, type Block, type ChatRow } from "@openorc/client";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadRichText } from "./ThreadImages";
import { UserMessage } from "./UserMessage";

type Theirs = Extract<ChatRow, { kind: "theirs" }>;
type Group = { kind: "theirs"; id: string; rows: Theirs[] } | { kind: "row"; id: string; row: Exclude<ChatRow, Theirs> };

const reactionKey = (runId: string | undefined, messageId: string, part: number) => `${runId ?? ""}|${messageId}|${part}`;

/** Consecutive messages from the Orcling read as one run beside its face; anything else stands alone. */
function groups(rows: ChatRow[]): Group[] {
  const out: Group[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (row.kind !== "theirs") out.push({ kind: "row", id: row.id, row });
    else if (last?.kind === "theirs") last.rows.push(row);
    else out.push({ kind: "theirs", id: row.id, rows: [row] });
  }
  return out;
}

/**
 * Messages that land while the person watches arrive a bubble at a time, each after a short typing beat, the way a
 * friend's texts do. Earlier history shows whole, and so does everything under reduced motion.
 */
function useArrivingBubbles(rows: ChatRow[], since: number) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<Record<string, number>>({});
  const arriving = reduced ? [] : rows.filter((row): row is Theirs => row.kind === "theirs" && (row.block.at ?? 0) > since);
  const next = arriving.find((row) => (shown[row.id] ?? 1) < row.bubbles.length);
  const nextId = next?.id;
  const nextCount = next ? (shown[next.id] ?? 1) : 0;
  const beat = next ? typingBeat(next.bubbles[nextCount] ?? "") : 0;
  useEffect(() => {
    if (!nextId) return;
    const timer = setTimeout(() => setShown((current) => ({ ...current, [nextId]: nextCount + 1 })), beat);
    return () => clearTimeout(timer);
  }, [nextId, nextCount, beat]);
  const waiting = next ? arriving.slice(arriving.indexOf(next) + 1).map((row) => row.id) : [];
  return {
    pending: Boolean(next),
    count: (row: Theirs) => {
      if (waiting.includes(row.id)) return 0;
      return row.id === next?.id ? nextCount : row.bubbles.length;
    },
  };
}

/**
 * The conversation's tapbacks by bubble. The person's own show the moment they choose, ahead of the core's copy, which
 * takes over once it agrees.
 */
function useReactions(threadId: string) {
  const list = useRpc("orclings.reactions", { threadId }).data;
  const [chosen, setChosen] = useState<ReadonlyMap<string, Reaction | null>>(new Map());
  const byKey = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const reaction of list ?? []) {
      const key = reactionKey(reaction.runId, reaction.messageId, reaction.part);
      map.set(key, [...(map.get(key) ?? []), reaction]);
    }
    return map;
  }, [list]);
  const recorded = (key: string) => byKey.get(key)?.find((reaction) => reaction.orclingId === null)?.reaction ?? null;
  // A choice gives way once the core's list agrees with it.
  useEffect(() => {
    setChosen((current) => {
      const waiting = [...current].filter(([key, reaction]) => (byKey.get(key)?.find((other) => other.orclingId === null)?.reaction ?? null) !== reaction);
      return waiting.length === current.size ? current : new Map(waiting);
    });
  }, [byKey]);
  return {
    person: (key: string) => (chosen.has(key) ? (chosen.get(key) ?? undefined) : (recorded(key) ?? undefined)),
    orcling: (key: string) => byKey.get(key)?.find((reaction) => reaction.orclingId !== null)?.reaction,
    choose: (key: string, reaction: Reaction | null) => setChosen((current) => new Map(current).set(key, reaction)),
  };
}

/** A tapback resting on a bubble's corner; a new one lands again. */
function ReactionBadge({ reaction, side }: { reaction: Reaction | undefined; side: "start" | "end" }) {
  if (!reaction) return null;
  return (
    <span key={reaction} className="orcling-reaction" data-side={side} aria-label={`Reacted ${reaction}`}>
      {reactionEmoji[reaction]}
    </span>
  );
}

/** The person's tapbacks, above an Orcling bubble while it is hovered or focused; choosing the current one takes it back. */
function ReactionBar({ current, onReact }: { current: Reaction | undefined; onReact: (reaction: Reaction | null) => void }) {
  return (
    <div className="orcling-react-bar" role="toolbar" aria-label="React">
      {Reaction.options.map((reaction) => (
        <button
          key={reaction}
          type="button"
          className="orcling-react-choice"
          aria-label={reaction}
          aria-pressed={current === reaction}
          data-current={current === reaction || undefined}
          onClick={() => onReact(current === reaction ? null : reaction)}
        >
          {reactionEmoji[reaction]}
        </button>
      ))}
    </div>
  );
}

/**
 * One bubble of the Orcling's. Choosing a tapback folds the bar away until the pointer comes back to the bubble or
 * focus leaves it. Leaving does not reset it: the folding bar lets go of the pointer, and that alone reads as a leave.
 */
function TheirBubble({ text, reaction, onReact }: { text: string; reaction: Reaction | undefined; onReact: (reaction: Reaction | null) => void }) {
  const [picked, setPicked] = useState(false);
  return (
    <div
      className="orcling-bubble-row"
      data-picked={picked || undefined}
      onPointerEnter={() => setPicked(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPicked(false);
      }}
    >
      <div className="orcling-bubble" data-reacted={reaction ? true : undefined}>
        <div className="text-prose text-ink prose-chat">
          <ThreadRichText mode="static">{text}</ThreadRichText>
        </div>
        <ReactionBadge reaction={reaction} side="end" />
      </div>
      <ReactionBar
        current={reaction}
        onReact={(next) => {
          setPicked(true);
          onReact(next);
        }}
      />
    </div>
  );
}

function Typing() {
  return (
    <div className="orcling-bubble orcling-typing" role="status" aria-label="Typing">
      <span />
      <span />
      <span />
    </div>
  );
}

function OrclingRun({
  rows,
  count,
  typing,
  orcling,
  reactions,
  onReact,
}: {
  rows: Theirs[];
  count: (row: Theirs) => number;
  typing: boolean;
  orcling: Orcling;
  reactions: ReturnType<typeof useReactions>;
  onReact: (row: Theirs, part: number, reaction: Reaction | null) => void;
}) {
  const bubbles = rows.flatMap((row) => row.bubbles.slice(0, count(row)).map((text, part) => ({ row, part, text })));
  if (!bubbles.length && !typing) return null;
  return (
    <div className="orcling-run" data-turn={rows[0]?.id ?? "typing"}>
      <OrclingAvatar orcling={orcling} size={28} className="orcling-run-face" />
      <div className="orcling-run-bubbles">
        {bubbles.map(({ row, part, text }) => (
          <TheirBubble key={`${row.id}:${part}`} text={text} reaction={reactions.person(reactionKey(row.block.runId, row.block.id, part))} onReact={(reaction) => onReact(row, part, reaction)} />
        ))}
        {typing ? <Typing /> : null}
      </div>
    </div>
  );
}

/**
 * An Orcling's own conversation, the way people text: the person's messages on the right, the Orcling's on the left
 * beside its face, one bubble per paragraph, typing dots while it works, and tapbacks both ways. `card` draws what
 * needs the person, such as an approval, as the work transcript would.
 */
/**
 * After a tapback, no bubble offers its bar until the pointer really moves: the folding bar uncovers the bubble under
 * the pointer, which would otherwise answer with a bar of its own, as if the first one had never closed.
 */
function useHush() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return {
    hushed: at !== null,
    hush: (x: number, y: number) => setAt({ x, y }),
    move: (event: PointerEvent) => {
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > 6) setAt(null);
    },
  };
}

export function OrclingChat({ orcling, blocks, live, card }: { orcling: Orcling; blocks: Block[]; live: boolean; card: (block: Block) => ReactNode }) {
  const since = useRef(Date.now()).current;
  const hush = useHush();
  const rows = useMemo(() => chatRows(blocks), [blocks]);
  const arriving = useArrivingBubbles(rows, since);
  const reactions = useReactions(orcling.threadId);
  const react = useRpcMutation("orclings.react");
  // A message on its way gets typing dots at once, before the agent has even taken it.
  const typing = live || arriving.pending || rows.some((row) => row.kind === "mine" && row.block.pending);
  const grouped = groups(rows);
  const lastRun = grouped.at(-1)?.kind === "theirs";
  const onReact = (row: Theirs, part: number, reaction: Reaction | null) => {
    if (!row.block.runId) return;
    reactions.choose(reactionKey(row.block.runId, row.block.id, part), reaction);
    react.mutate({ threadId: orcling.threadId, runId: row.block.runId, messageId: row.block.id, part, reaction });
  };
  const run = (group: Extract<Group, { kind: "theirs" }>, last: boolean) => (
    <OrclingRun key={group.id} rows={group.rows} count={arriving.count} typing={last && typing} orcling={orcling} reactions={reactions} onReact={onReact} />
  );
  return (
    <div
      className="orcling-chat"
      data-hushed={hush.hushed || undefined}
      onPointerMove={hush.move}
      onClickCapture={(event) => {
        if ((event.target as Element).closest(".orcling-react-choice")) hush.hush(event.clientX, event.clientY);
      }}
      style={{ "--orcling-tint": orcling.look.bodyColor } as CSSProperties}
    >
      {grouped.map((group, index) => {
        if (group.kind === "theirs") return run(group, index === grouped.length - 1);
        const { row } = group;
        if (row.kind === "time")
          return (
            <div key={row.id} className="orcling-chat-time" data-turn={row.id}>
              {stretchTime(row.at)}
            </div>
          );
        if (row.kind === "mine") {
          return (
            <div key={row.id} className="orcling-chat-mine" data-turn={row.id} data-pending={row.block.pending || undefined}>
              <UserMessage
                text={row.block.text}
                at={row.block.at}
                attachments={row.block.attachments}
                badge={<ReactionBadge reaction={reactions.orcling(reactionKey(row.block.runId, row.block.id, 0))} side="start" />}
              />
            </div>
          );
        }
        return (
          <div key={row.id} className="orcling-chat-card" data-turn={row.id}>
            {card(row.block)}
          </div>
        );
      })}
      {typing && !lastRun ? run({ kind: "theirs", id: "typing", rows: [] }, true) : null}
    </div>
  );
}
