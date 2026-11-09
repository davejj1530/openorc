import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Reaction, reactionEmoji, type MessageReaction, type Orcling } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { useReducedMotion } from "../lib/motion";
import { chatRows, stretchTime, typingBeat, type Block, type ChatRow } from "@openorc/client";
import { orclingById, useOrclings } from "../lib/orclings";
import type { OrclingChatSpec } from "../lib/turn-authors";
import { SmilePlus } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { ThreadRichText } from "./ThreadImages";
import { UserMessage } from "./UserMessage";

type Theirs = Extract<ChatRow, { kind: "theirs" }>;
type Group = { kind: "theirs"; id: string; rows: Theirs[] } | { kind: "row"; id: string; row: Exclude<ChatRow, Theirs> };

const reactionKey = (runId: string | undefined, messageId: string, part: number) => `${runId ?? ""}|${messageId}|${part}`;

/** Consecutive messages from one Orcling to one place read as one run beside its face; anything else stands alone. */
function groups(rows: ChatRow[], speakerOf: (row: Theirs) => Orcling): Group[] {
  const out: Group[] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (row.kind !== "theirs") out.push({ kind: "row", id: row.id, row });
    else if (last?.kind === "theirs" && speakerOf(last.rows[0]!).id === speakerOf(row).id && last.rows[0]!.to === row.to) last.rows.push(row);
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

/** The person's tapbacks, above an Orcling bubble once its reaction button opens them; choosing the current one takes it back. */
function ReactionBar({ open, current, onReact }: { open: boolean; current: Reaction | undefined; onReact: (reaction: Reaction | null) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const choice = bar.current?.querySelector<HTMLButtonElement>("[data-current]") ?? bar.current?.querySelector<HTMLButtonElement>("button");
    if (open) choice?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div ref={bar} className="orcling-react-bar" role="toolbar" aria-label="Reactions" inert={!open}>
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
 * One bubble of the Orcling's. Pointing at it shows a reaction button beside it; the button opens the tapbacks, and
 * choosing one closes them again. They never open on their own, so nothing pops up under a resting pointer.
 */
function TheirBubble({
  text,
  reaction,
  open,
  onOpen,
  onReact,
}: {
  text: string;
  reaction: Reaction | undefined;
  open: boolean;
  onOpen: (open: boolean) => void;
  onReact: (reaction: Reaction | null) => void;
}) {
  return (
    <div className="orcling-bubble-row" data-open={open || undefined}>
      <div className="orcling-bubble" data-reacted={reaction ? true : undefined}>
        <div className="text-prose text-ink prose-chat">
          <ThreadRichText mode="static">{text}</ThreadRichText>
        </div>
        <ReactionBadge reaction={reaction} side="end" />
      </div>
      <button type="button" className="orcling-react-open" aria-label="React" aria-expanded={open} onClick={() => onOpen(!open)}>
        <SmilePlus size={16} />
      </button>
      <ReactionBar
        open={open}
        current={reaction}
        onReact={(next) => {
          onReact(next);
          onOpen(false);
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
  label,
  reactions,
  onReact,
  picking,
}: {
  rows: Theirs[];
  count: (row: Theirs) => number;
  typing: boolean;
  orcling: Orcling;
  /** Who is speaking and to whom, where more than one Orcling can speak. */
  label: string | null;
  reactions: ReturnType<typeof useReactions>;
  onReact: (row: Theirs, part: number, reaction: Reaction | null) => void;
  picking: Picking;
}) {
  const bubbles = rows.flatMap((row) => row.bubbles.slice(0, count(row)).map((text, part) => ({ row, part, text })));
  if (!bubbles.length && !typing) return null;
  return (
    <div className="orcling-run" data-turn={rows[0]?.id ?? "typing"} style={{ "--orcling-tint": orcling.look.bodyColor } as CSSProperties}>
      {label && bubbles.length ? <span className="orcling-run-name">{label}</span> : null}
      <OrclingAvatar orcling={orcling} size={28} className="orcling-run-face" />
      <div className="orcling-run-bubbles">
        {bubbles.map(({ row, part, text }) => {
          const key = reactionKey(row.block.runId, row.block.id, part);
          return (
            <TheirBubble
              key={`${row.id}:${part}`}
              text={text}
              reaction={reactions.person(key)}
              open={picking.open === key}
              onOpen={(open) => picking.set(open ? key : null)}
              onReact={(reaction) => onReact(row, part, reaction)}
            />
          );
        })}
        {typing ? <Typing /> : null}
      </div>
    </div>
  );
}

type Picking = { open: string | null; set: (key: string | null) => void };

/** One bubble's tapbacks open at a time; Escape or a press anywhere else closes them. */
function usePicking(): Picking {
  const [open, set] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = () => set(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const press = (event: globalThis.PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".orcling-bubble-row[data-open]")) close();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", press, true);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", press, true);
    };
  }, [open]);
  return { open, set };
}

/**
 * An Orcling chat, its own or a group's, the way people text: the person's messages on the right, each Orcling's on the
 * left beside its face and in its own tint, one bubble per paragraph, typing dots while one works, and tapbacks both
 * ways. Where more than one Orcling can speak, a run of bubbles carries its speaker's name, and a message an Orcling
 * sent another says whom it went to. `card` draws what needs the person, such as an approval, as the work transcript would.
 */
export function OrclingChat({ chat, blocks, live, card }: { chat: OrclingChatSpec; blocks: Block[]; live: boolean; card: (block: Block) => ReactNode }) {
  const since = useRef(Date.now()).current;
  const picking = usePicking();
  const everyone = useOrclings();
  const origins = useRpc("orclings.origins", { threadId: chat.threadId }).data;
  const rows = useMemo(() => chatRows(blocks, new Map((origins ?? []).map((origin) => [origin.messageId, origin.fromOrclingId]))), [blocks, origins]);
  const arriving = useArrivingBubbles(rows, since);
  const reactions = useReactions(chat.threadId);
  const react = useRpcMutation("orclings.react");
  const own = chat.members[0]!;
  const speakerOf = (row: Theirs) => orclingById(everyone, row.from) ?? (row.block.runId ? chat.speakers.get(row.block.runId) : undefined) ?? own;
  // A message on its way gets typing dots at once, before the agent has even taken it.
  const typing = live || arriving.pending || rows.some((row) => row.kind === "mine" && row.block.pending);
  const latest = blocks.findLast((block) => block.runId && chat.speakers.has(block.runId));
  const typist = (latest?.runId && chat.speakers.get(latest.runId)) || own;
  const grouped = groups(rows, speakerOf);
  const lastRun = grouped.at(-1)?.kind === "theirs";
  const label = (row: Theirs | undefined, speaker: Orcling) => {
    if (row?.to) return `${speaker.name} to ${row.to}`;
    return chat.group || speaker.id !== own.id ? speaker.name : null;
  };
  const onReact = (row: Theirs, part: number, reaction: Reaction | null) => {
    if (!row.block.runId) return;
    reactions.choose(reactionKey(row.block.runId, row.block.id, part), reaction);
    react.mutate({ threadId: chat.threadId, runId: row.block.runId, messageId: row.block.id, part, reaction });
  };
  const run = (group: Extract<Group, { kind: "theirs" }>, last: boolean) => {
    const speaker = group.rows[0] ? speakerOf(group.rows[0]) : typist;
    return (
      <OrclingRun
        key={group.id}
        rows={group.rows}
        count={arriving.count}
        typing={last && typing && speaker.id === typist.id}
        orcling={speaker}
        label={label(group.rows[0], speaker)}
        reactions={reactions}
        onReact={onReact}
        picking={picking}
      />
    );
  };
  return (
    <div className="orcling-chat">
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
      {typing && (!lastRun || speakerOf((grouped.at(-1) as Extract<Group, { kind: "theirs" }>).rows[0]!).id !== typist.id) ? run({ kind: "theirs", id: "typing", rows: [] }, true) : null}
    </div>
  );
}
