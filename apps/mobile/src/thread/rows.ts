import {
  isLive,
  reasoningSections,
  subagentGroups,
  turnReply,
  turnShowsSender,
  turnStatus,
  turnStatusWords,
  turnShowsVoice,
  visualizationFromTool,
  workParts,
  workTiming,
  workTurns,
  type Block,
} from "@openorc/client";
import type { ThreadNote, ThreadPerson, Visualization } from "@openorc/protocol";
import { height } from "../generated/tokens";
import { messagePieces } from "./markdown-chunks";
import { NO_NOTES, notesAfter, notesKey, type NotePlaces } from "./note-places";
import { holdsProof, NO_PROOFS, replyProofs, type ReplyProof } from "./reply-proof";
import { messageAuthor, turnSender, type ThreadSenders } from "./senders";
import { NO_VOICES, voiceOf, type Voice, type Voices } from "./voices";
import type { WaitingApproval } from "./waiting-approvals";

export type MessageBlock = Extract<Block, { kind: "message" }>;
type ToolBlock = Extract<Block, { kind: "tool" }>;

/** The live block a turn's work line follows: a step still running, the reply streaming after the work, or nothing. */
export type WorkNow = Block | "reply" | null;

/**
 * One row of the phone transcript: the units a turn reads as on the desktop, in its order. A person's message, then the
 * turn's head where it has one, its folded work, what follows the work (the reply, an approval, a question, an error)
 * and the turn's end; the agent's presence ends the transcript. `gap` is the space above the row.
 */
export type Row = { key: string; gap: number } & (
  | { kind: "prompt"; block: MessageBlock }
  | { kind: "notice"; block: MessageBlock }
  /**
   * A turn's head, only where it has something to say: the agent where it changed from the turn before
   * (`voice`), and in a cloud thread others are in, who sent the turn where its prompt does not already name them
   * (`sender`; null: a former member).
   */
  | { kind: "head"; voice: Voice | null; sender: ThreadPerson | null | undefined }
  | { kind: "work"; turnId: string; runId: string; work: Block[]; live: boolean; now: WorkNow }
  /**
   * A piece of a reply: long replies are drawn a piece per row, so the list lays them out a piece at a time. The piece
   * still streaming reads its words from the run as they arrive (`source`), so the list itself holds still.
   */
  | { kind: "reply"; text: string; streaming: boolean; source: PieceSource; proofs: ReplyProof[] }
  | { kind: "card"; runId: string; block: Block }
  | { kind: "subagents"; blocks: ToolBlock[] }
  /** The run that asks what the cards after it ask, outside the loaded conversation: its task's title, or its agent's. */
  | { kind: "waiting"; runId: string; title: string | null }
  /** An explanation the agent drew with the visualize tool, in a web view of its own. */
  | { kind: "visualization"; runId: string; block: ToolBlock; visualization: Visualization }
  /**
   * Where a turn stands, "Working 12s" while it runs and "Worked for 41s" once done, then Copy for its reply once done:
   * one row from the turn's start to its end, so finishing swaps words in place and moves nothing. Its words are worked
   * out from primitives, so a streaming reply leaves the row alone.
   */
  | {
      kind: "end";
      live: boolean;
      writing: boolean;
      startedAt: number | undefined;
      durationMs: number | undefined;
      outcome: string | undefined;
      /** The reply Copy copies, once the turn is done. */
      text: string | null;
    }
  | { kind: "presence"; working: boolean }
  /** A note in a cloud thread: words for the people it tags, beside the agent's work and never to it. */
  | { kind: "note"; note: ThreadNote }
);

/**
 * The desktop's rhythm (conversation.css): a turn's parts 14 apart, a prompt 28 above what follows it, a new turn 24
 * below the last. The end row tucks 4 closer, as the desktop's does.
 */
const GAP = { part: 14, prompt: 28, turn: 24, end: 10 };
/**
 * The work's receipt is a 44 pt touch row on a 16 pt line, so the work row keeps this much inside itself above the
 * line and below what it shows; the gaps beside it give that back.
 */
const WORK_SPACE = (44 - 16) / 2;
const spaceBelow = (row: Unspaced | undefined) => (row?.kind === "work" ? WORK_SPACE : 0);

export type RowKind = Row["kind"];

/** Where a reply piece's words live: the message in its run, and which piece of it this is. */
export interface PieceSource {
  runId: string;
  blockId: string;
  index: number;
}

/** What the previous pass made of each turn, so turns and rows that did not change keep their objects. */
export interface RowMemo {
  turns: Map<string, { blocks: Block[]; live: boolean; opening: number; names: HeadNames; notes: string; rows: Row[] }>;
  /** The notes before every turn, as last drawn. */
  top: { key: string; rows: Row[] };
  /** The last pass's rows, handed back whole when no row changed. */
  rows: Row[];
}

export const emptyRowMemo = (): RowMemo => ({ turns: new Map(), top: { key: "", rows: [] }, rows: [] });

const sameItems = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);

type RowOf<K extends RowKind> = Extract<Row, { kind: K }>;
const sameBlock = (a: { block: Block }, b: { block: Block }) => a.block === b.block;

function sameExcept<T extends object>(a: T, b: T, field: keyof T): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof T)[]);
  return [...keys].every((key) => key === field || a[key] === b[key]);
}

/**
 * Whether two texts of reasoning under way draw the same steps: the same titles, and the last one with words or
 * without, since its first words make its step one that opens.
 */
function sameSteps(a: string, b: string): boolean {
  const before = reasoningSections(a);
  const after = reasoningSections(b);
  const titled = (sections: typeof before) => sections.map((section) => section.title);
  return sameItems(titled(before), titled(after)) && Boolean(before.at(-1)?.body) === Boolean(after.at(-1)?.body);
}

/**
 * The same block as far as the work row draws it. A running call shows what it is for, not its output (the tool
 * sheet reads that from the run). Reasoning under way draws its titles as steps, and the live step reads its words
 * from the run as they arrive, so only a new title, or a step's first words, changes the row.
 */
function drawnSame(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.kind === "tool" && b.kind === "tool") return !a.done && !b.done && sameExcept(a, b, "output");
  if (a.kind === "thinking" && b.kind === "thinking") return a.endedAt === null && b.endedAt === null && sameExcept(a, b, "text") && sameSteps(a.text, b.text);
  return false;
}

const sameNow = (a: WorkNow, b: WorkNow) => a === b || (typeof a === "object" && typeof b === "object" && a !== null && b !== null && drawnSame(a, b));

const sameVoice = (a: Voice | null, b: Voice | null) => a === b || (a !== null && b !== null && a.agent === b.agent && a.model === b.model);
const samePerson = (a: ThreadPerson | null | undefined, b: ThreadPerson | null | undefined) => a === b || (Boolean(a && b) && a?.id === b?.id && a?.name === b?.name);

const sameHeadNames = (a: HeadNames, b: HeadNames) => a.senders === b.senders && sameVoice(a.voice, b.voice);

/** When two rows with one key show the same thing, per kind: same blocks, same names for the head, same piece. */
const sameAs: { [K in RowKind]: (a: RowOf<K>, b: RowOf<K>) => boolean } = {
  prompt: sameBlock,
  notice: sameBlock,
  card: sameBlock,
  subagents: (a, b) => sameItems(a.blocks, b.blocks),
  waiting: (a, b) => a.runId === b.runId && a.title === b.title,
  visualization: sameBlock,
  end: (a, b) => a.live === b.live && a.writing === b.writing && a.startedAt === b.startedAt && a.durationMs === b.durationMs && a.outcome === b.outcome && a.text === b.text,
  presence: (a, b) => a.working === b.working,
  note: (a, b) => a.note.id === b.note.id && a.note.read === b.note.read,
  head: (a, b) => sameVoice(a.voice, b.voice) && samePerson(a.sender, b.sender),
  // A streamed delta the row does not draw keeps the row, so the list and the open steps card hold still.
  work: (a, b) => a.live === b.live && a.runId === b.runId && sameNow(a.now, b.now) && a.work.length === b.work.length && a.work.every((block, i) => drawnSame(block, b.work[i]!)),
  // A streaming piece reads its own words, so only a change of shape makes it a new row.
  reply: (a, b) => a.streaming === b.streaming && (a.streaming || a.text === b.text) && a.proofs === b.proofs,
};

function sameRow(a: Row, b: Row): boolean {
  return a.kind === b.kind && a.gap === b.gap && (sameAs[a.kind] as (a: Row, b: Row) => boolean)(a, b);
}

type Unspaced = Row extends infer R ? (R extends Row ? Omit<R, "gap"> : never) : never;

function runOf(blocks: Block[], fallback: string): string {
  return blocks.find((block) => block.runId)?.runId ?? fallback;
}

/** The row key of one piece of a reply. */
export const replyKey = (blockId: string, index: number) => `reply:${blockId}:${index}`;

/** Each finished reply's proofs by piece, read once: a finished turn's work does not change. */
const proven = new WeakMap<MessageBlock, ReplyProof[][]>();

/**
 * The proofs each piece of a reply shows, each on the first piece that holds its line. `work`: the turn's work once
 * the turn has ended; a reply still being written, or one whose turn still runs, shows none.
 */
function pieceProofs(block: MessageBlock, pieces: string[], work: Block[] | null): ReplyProof[][] | null {
  if (!work?.length || block.streaming) return null;
  const known = proven.get(block);
  if (known) return known;
  const placed: ReplyProof[][] = pieces.map(() => NO_PROOFS);
  for (const proof of replyProofs(block.text, work)) {
    const index = pieces.findIndex((piece) => holdsProof(piece, proof));
    if (index >= 0) placed[index] = [...placed[index]!, proof];
  }
  proven.set(block, placed);
  return placed;
}

/** A reply as its pieces; only the last can still be streaming. An empty streaming reply is one row that waits. */
function replyRows(block: MessageBlock, runId: string, work: Block[] | null): Unspaced[] {
  const pieces = messagePieces(block);
  const proofs = pieceProofs(block, pieces, work);
  return pieces.map((text, index) => ({
    kind: "reply",
    key: replyKey(block.id, index),
    text,
    streaming: block.streaming && index === pieces.length - 1,
    source: { runId: block.runId ?? runId, blockId: block.id, index },
    proofs: proofs?.[index] ?? NO_PROOFS,
  }));
}

/** A provider's error the agent passed on as its words: drawn as an error card, not as the reply. */
const providerError = (block: Block) => block.kind === "message" && block.role === "assistant" && /^API Error:/.test(block.text);

/** `work`: the ended turn's work, which its reply's claims rest on. */
function afterRows(block: Block, runId: string, work: Block[] | null = null): Unspaced[] {
  if (block.kind === "message" && block.role === "assistant" && !providerError(block)) return replyRows(block, runId, work);
  if (block.kind === "message" && block.role === "system") return [{ kind: "notice", key: `notice:${block.id}`, block }];
  const visualization = block.kind === "tool" ? visualizationFromTool(block) : null;
  if (block.kind === "tool" && visualization) return [{ kind: "visualization", key: `visualization:${block.id}`, runId, block, visualization }];
  return [{ kind: "card", key: `card:${block.id}`, runId, block }];
}

function beforeRows(block: Block, runId: string): Unspaced[] {
  if (block.kind !== "message" || block.role !== "user") return afterRows(block, runId);
  return block.text || block.attachments?.length ? [{ kind: "prompt", key: `prompt:${block.id}`, block }] : [];
}

function afterTurnRows(after: Block[], runId: string, work: Block[] | null): Unspaced[] {
  const rows: Unspaced[] = [];
  const groups = subagentGroups(after);
  for (const block of after) {
    if (block.kind === "tool" && block.subagent) {
      const group = groups.get(block.id);
      if (group) rows.push({ kind: "subagents", key: `subagents:${block.id}`, blocks: group });
      continue;
    }
    // "turn error" and "session error" restate the error card above them.
    if (block.kind === "status" && /^(turn|session) /.test(block.text)) continue;
    rows.push(...afterRows(block, runId, work));
  }
  return rows;
}

/**
 * What the open thread knows of who speaks in it, for the turn heads: each run's agent and the thread's own,
 * and in a cloud thread, who sent each turn and wrote each prompt.
 */
export interface TurnNames {
  voices: Voices;
  senders: ThreadSenders | null;
}

export const NO_NAMES: TurnNames = { voices: NO_VOICES, senders: null };

/** What a turn's head may name: its voice where it changed from the turn before, and the thread's senders. */
interface HeadNames {
  voice: Voice | null;
  senders: ThreadSenders | null;
}

/** A turn's rows, in the desktop's order: before the work, the head where it has one and the work, what follows it, the end. */
function turnParts(turn: { id: string; blocks: Block[] }, live: boolean, fallbackRunId: string, names: HeadNames, notes: NotePlaces): Unspaced[] {
  const runId = runOf(turn.blocks, fallbackRunId);
  const timing = workTiming(turn.blocks, live);
  const { before, work, after } = workParts(turn.blocks, timing.live);
  const rows: Unspaced[] = before.flatMap((block) => beforeRows(block, runId));
  rows.push(...noteRows(notesAfter(notes, before)));
  const ended = timing.outcome === "error" || timing.outcome === "cancelled";
  const spoke = Boolean(work.length || after.length || timing.live || ended);
  const sender = turnSender(names.senders, turn.blocks, timing.live);
  const prompt = before.findLast((block) => block.kind === "message" && block.role === "user")?.id;
  const sent = turnShowsSender(sender, messageAuthor(names.senders, prompt)) ? sender : undefined;
  if (spoke && (names.voice || sent !== undefined)) rows.push({ kind: "head", key: `head:${turn.id}`, voice: names.voice, sender: sent });
  const cards = after.filter((block) => block.kind === "approval");
  const segments = workSegments(turn.blocks, work, cards);
  const last = segments.findLastIndex((segment) => segment.length > 0);
  segments.forEach((segment, index) => {
    if (segment.length) {
      const key = index ? `${turn.id}:${index}` : turn.id;
      const live = timing.live && index === last;
      rows.push({ kind: "work", key: `work:${key}`, turnId: key, runId, work: segment, live, now: index === last ? workNow(turn.blocks, after, timing.live) : null });
    }
    const card = cards[index];
    if (card) rows.push(...afterRows(card, runId));
  });
  rows.push(...noteRows(notesAfter(notes, work)));
  const rest = after.filter((block) => block.kind !== "approval");
  rows.push(...afterTurnRows(rest, runId, timing.live ? null : work));
  const reply = turnReply(after.filter((block) => !providerError(block)));
  const writing = after.some((block) => block.kind === "message" && block.role === "assistant" && block.streaming);
  const end = { live: timing.live, writing, startedAt: timing.startedAt, durationMs: timing.durationMs, outcome: timing.outcome };
  // A finished turn that neither took a time nor said anything to copy has nothing to end on.
  if (spoke && (turnStatusWords(turnStatus(end, 0)) || reply)) rows.push({ kind: "end", key: `end:${turn.id}`, ...end, text: !timing.live && reply ? reply.text : null });
  // What follows the work, and any block the turn does not draw, has its notes after the turn's end.
  const placed = new Set([...before, ...work]);
  rows.push(
    ...noteRows(
      notesAfter(
        notes,
        turn.blocks.filter((block) => !placed.has(block)),
      ),
    ),
  );
  return rows;
}

const noteRows = (notes: readonly ThreadNote[]): Unspaced[] => notes.map((note) => ({ kind: "note", key: `note:${note.id}`, note }));

/**
 * The work in the order it ran, cut at each question or approval card: what the agent did after an answer reads below
 * the card rather than joining the steps above it, so the newest step stays at the end of the conversation.
 */
function workSegments(blocks: Block[], work: Block[], cards: Block[]): Block[][] {
  if (!cards.length) return [work];
  const inWork = new Set(work);
  const cuts = new Set(cards);
  const segments: Block[][] = [[]];
  for (const block of blocks) {
    if (cuts.has(block)) segments.push([]);
    else if (inWork.has(block)) segments.at(-1)!.push(block);
  }
  return segments;
}

/**
 * What a turn's work row says the turn is on: the live block, the reply being written, or, with nothing live while the
 * turn runs, a note that just finished below the work, which names the step it announced.
 */
function workNow(blocks: Block[], after: Block[], live: boolean): WorkNow {
  const current = blocks.findLast(isLive);
  if (current) return current.kind === "message" ? "reply" : current;
  const note = live ? after.at(-1) : undefined;
  return note?.kind === "message" && note.role === "assistant" ? note : null;
}

/** The space above a row in a turn, by the row above it; the turn's first row takes `opening`. */
function gapAbove(row: Unspaced, above: Unspaced | undefined, opening: number): number {
  if (row.kind === "end") return Math.max(0, GAP.end - spaceBelow(above));
  const space = above ? (above.kind === "prompt" ? GAP.prompt : GAP.part) - spaceBelow(above) : opening;
  return Math.max(0, row.kind === "work" ? space - WORK_SPACE : space);
}

/** A turn's rows with the space above each; `opening` is the space above its first. */
function turnRows(turn: { id: string; blocks: Block[] }, live: boolean, fallbackRunId: string, opening: number, names: HeadNames, notes: NotePlaces): Row[] {
  return turnParts(turn, live, fallbackRunId, names, notes).map((row, index, rows) => ({ ...row, gap: gapAbove(row, rows[index - 1], opening) }) as Row);
}

/**
 * What the thread screen knows of the conversation's activity, as the desktop passes it: `live` while the newest turn
 * may still run, and `working` while the thread is busy, which counts background work its turn left running.
 */
export interface TranscriptActivity {
  live: boolean;
  working: boolean;
}

/**
 * The transcript as rows. A turn whose blocks are the same objects as last time keeps its rows; in a turn that
 * changed, each row that shows the same thing keeps its object too, and when no row changed the list gets the same
 * array back. So a streamed word changes no row at all (the streaming piece reads its words itself), and a frame that
 * updates a step hands the list that one new row.
 */
export function transcriptRows(blocks: Block[], { live, working }: TranscriptActivity, runId: string, memo: RowMemo, { voices, senders }: TurnNames = NO_NAMES, notes: NotePlaces = NO_NOTES): Row[] {
  const turns = workTurns(blocks);
  const next: RowMemo["turns"] = new Map();
  const rows: Row[] = [...topNoteRows(memo, notes)];
  // Each turn names its agent only where it changed from the turn before; the first, from the thread's own.
  let spoken = voices.own;
  turns.forEach((turn, index) => {
    const turnLive = live && index === turns.length - 1;
    const voice = voiceOf(voices, runOf(turn.blocks, runId));
    const names = { voice: voice && turnShowsVoice(voice, spoken) ? voice : null, senders };
    spoken = voice;
    // A prompt whose answer came as a turn of its own still sits 28 above it.
    const opening = (rows.at(-1)?.kind === "prompt" ? GAP.prompt : GAP.turn) - spaceBelow(rows.at(-1));
    const previous = memo.turns.get(turn.id);
    const noted = notesKey(notesAfter(notes, turn.blocks));
    if (previous && previous.live === turnLive && previous.opening === opening && previous.notes === noted && sameHeadNames(previous.names, names) && sameItems(previous.blocks, turn.blocks)) {
      next.set(turn.id, previous);
      rows.push(...previous.rows);
      return;
    }
    const kept = new Map(previous?.rows.map((row) => [row.key, row]));
    const fresh = turnRows(turn, turnLive, runId, opening, names, notes).map((row) => {
      const before = kept.get(row.key);
      return before && sameRow(row, before) ? before : row;
    });
    next.set(turn.id, { blocks: turn.blocks, live: turnLive, opening, names, notes: noted, rows: fresh });
    rows.push(...fresh);
  });
  memo.turns = next;
  if (turns.length) rows.push(presenceRow(memo, working, GAP.part - spaceBelow(rows.at(-1))));
  if (sameItems(rows, memo.rows)) return memo.rows;
  memo.rows = rows;
  return rows;
}

/** The notes from before every loaded turn, the same rows while they are the same notes. */
function topNoteRows(memo: RowMemo, notes: NotePlaces): Row[] {
  const key = notesKey(notes.top);
  if (memo.top.key !== key) memo.top = { key, rows: noteRows(notes.top).map((row, index) => ({ ...row, gap: index ? GAP.part : 0 }) as Row) };
  return memo.top.rows;
}

/**
 * What waits on the person outside the loaded conversation, after it and before the agent's presence: a head for each
 * run, then a card for each approval or question it asks.
 */
export function withWaitingApprovals(rows: Row[], waiting: readonly WaitingApproval[]): Row[] {
  if (!waiting.length) return rows;
  const presence = rows.at(-1)?.kind === "presence" ? rows.at(-1) : undefined;
  const added: Row[] = presence ? rows.slice(0, -1) : rows.slice();
  for (const { runId, task, blocks } of waiting) {
    const above = added.at(-1);
    added.push({ kind: "waiting", key: `waiting:${runId}`, gap: above ? GAP.turn - spaceBelow(above) : 0, runId, title: task });
    for (const block of blocks) added.push({ kind: "card", key: `card:${runId}:${block.id}`, gap: GAP.part, runId, block });
  }
  if (presence) added.push({ ...presence, gap: GAP.part });
  return added;
}

/** The agent at the end of the conversation, working while the thread is, the same row object until that changes. */
function presenceRow(memo: RowMemo, working: boolean, gap: number): Row {
  const last = memo.rows.at(-1);
  return last?.kind === "presence" && last.working === working && last.gap === gap ? last : { kind: "presence", key: "presence", gap, working };
}

/**
 * The newest row, the one the New chip watches: the agent's presence always ends the list, and a running turn's end
 * stays below what the turn adds, so neither is news; a turn that finished is.
 */
export const newestRow = (rows: Row[]): Row | null => rows.findLast((row) => row.kind !== "presence" && !(row.kind === "end" && row.live)) ?? null;

/** What the end of the conversation holds: its newest row, and how much the newest reply has said so far. */
export interface EndMark {
  row: Row | null;
  said: number;
}

/** A streaming reply grows inside one row, so the length of what it has said counts as well as a new row. */
export function endMark(rows: Row[], blocks: readonly Block[]): EndMark {
  const last = blocks.at(-1);
  return { row: newestRow(rows), said: last?.kind === "message" && last.role === "assistant" ? last.text.length : 0 };
}

/** Something arrived at the end since the reader last saw it there. */
export const isNews = (seen: EndMark | null, now: EndMark): boolean => seen !== null && (now.row !== seen.row || now.said > seen.said);

/** Question cards still waiting for an answer: they hold picks and typed text, so they stay mounted off screen. */
export function unsentRows(rows: Row[]): string[] {
  return rows.flatMap((row) => (row.kind === "card" && row.block.kind === "approval" && row.block.approvalKind === "user_input" && !row.block.decision ? [row.key] : []));
}

/**
 * Rows that are always this tall below their gap, so the list places them exactly before they draw: a turn's head where
 * it keeps one, a waiting run's head, a turn's end (one control, live or done) and the agent's presence. Their views
 * take these heights from here.
 */
export const FIXED_HEIGHT = { head: 16, waiting: 16, end: height["control-md"], presence: 36 } as const satisfies Partial<Record<RowKind, number>>;

export function fixedHeight(row: Row): number | undefined {
  const fixed: number | undefined = (FIXED_HEIGHT as Partial<Record<RowKind, number>>)[row.kind];
  return fixed === undefined ? undefined : row.gap + fixed;
}
