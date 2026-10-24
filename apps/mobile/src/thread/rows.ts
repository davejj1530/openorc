import { isLive, reasoningSections, turnReply, workParts, workTiming, workTurns, type Block } from "@openorc/client";
import { height } from "../generated/tokens";
import { messagePieces } from "./markdown-chunks";

export type MessageBlock = Extract<Block, { kind: "message" }>;

/** The live block a turn's work line follows: a step still running, the reply streaming after the work, or nothing. */
export type WorkNow = Block | "reply" | null;

/**
 * One row of the phone transcript: the units a turn reads as on the desktop, in its order. A person's message, then the
 * turn's head, its folded work, what follows the work (the reply, an approval, a question, an error) and the finished
 * reply's actions; the agent's presence ends the transcript. `gap` is the space above the row.
 */
export type Row = { key: string; gap: number } & (
  | { kind: "prompt"; block: MessageBlock }
  | { kind: "notice"; block: MessageBlock }
  /** The head's words are worked out from primitives, so a streaming reply leaves the head alone. */
  | { kind: "head"; runId: string; live: boolean; writing: boolean; startedAt: number | undefined; durationMs: number | undefined; outcome: string | undefined }
  | { kind: "work"; turnId: string; runId: string; work: Block[]; live: boolean; now: WorkNow }
  /**
   * A piece of a reply: long replies are drawn a piece per row, so the list lays them out a piece at a time. The piece
   * still streaming reads its words from the run as they arrive (`source`), so the list itself holds still.
   */
  | { kind: "reply"; text: string; streaming: boolean; source: PieceSource }
  | { kind: "card"; runId: string; block: Block }
  /** Copy for a finished turn's reply. */
  | { kind: "actions"; text: string }
  | { kind: "presence"; working: boolean }
);

/**
 * The desktop's rhythm (conversation.css): a turn's parts 14 apart, a prompt 28 above what follows it, a new turn 24
 * below the last. The actions row tucks 4 closer, as the desktop's does.
 */
const GAP = { part: 14, prompt: 28, turn: 24, actions: 10 };

export type RowKind = Row["kind"];

/** Where a reply piece's words live: the message in its run, and which piece of it this is. */
export interface PieceSource {
  runId: string;
  blockId: string;
  index: number;
}

/** What the previous pass made of each turn, so turns and rows that did not change keep their objects. */
export interface RowMemo {
  turns: Map<string, { blocks: Block[]; live: boolean; opening: number; rows: Row[] }>;
  /** The last pass's rows, handed back whole when no row changed. */
  rows: Row[];
}

export const emptyRowMemo = (): RowMemo => ({ turns: new Map(), rows: [] });

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

/** When two rows with one key show the same thing, per kind: same blocks, same words for the head, same piece. */
const sameAs: { [K in RowKind]: (a: RowOf<K>, b: RowOf<K>) => boolean } = {
  prompt: sameBlock,
  notice: sameBlock,
  card: sameBlock,
  actions: (a, b) => a.text === b.text,
  presence: (a, b) => a.working === b.working,
  head: (a, b) => a.live === b.live && a.writing === b.writing && a.startedAt === b.startedAt && a.durationMs === b.durationMs && a.outcome === b.outcome && a.runId === b.runId,
  // A streamed delta the row does not draw keeps the row, so the list and the open steps card hold still.
  work: (a, b) => a.live === b.live && a.runId === b.runId && sameNow(a.now, b.now) && a.work.length === b.work.length && a.work.every((block, i) => drawnSame(block, b.work[i]!)),
  // A streaming piece reads its own words, so only a change of shape makes it a new row.
  reply: (a, b) => a.streaming === b.streaming && (a.streaming || a.text === b.text),
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

/** A reply as its pieces; only the last can still be streaming. An empty streaming reply is one row that waits. */
function replyRows(block: MessageBlock, runId: string): Unspaced[] {
  const pieces = messagePieces(block);
  return pieces.map((text, index) => ({
    kind: "reply",
    key: replyKey(block.id, index),
    text,
    streaming: block.streaming && index === pieces.length - 1,
    source: { runId: block.runId ?? runId, blockId: block.id, index },
  }));
}

function afterRows(block: Block, runId: string): Unspaced[] {
  if (block.kind === "message" && block.role === "assistant" && !/^API Error:/.test(block.text)) return replyRows(block, runId);
  if (block.kind === "message" && block.role === "system") return [{ kind: "notice", key: `notice:${block.id}`, block }];
  return [{ kind: "card", key: `card:${block.id}`, runId, block }];
}

/** A turn's rows, in the desktop's order: before the work, the head and the work, then what follows it. */
function turnParts(turn: { id: string; blocks: Block[] }, live: boolean, fallbackRunId: string): Unspaced[] {
  const runId = runOf(turn.blocks, fallbackRunId);
  const timing = workTiming(turn.blocks, live);
  const { before, work, after } = workParts(turn.blocks, timing.live);
  const rows: Unspaced[] = before.flatMap((block) => (block.kind === "message" && block.role === "user" ? [{ kind: "prompt", key: `prompt:${block.id}`, block } as const] : afterRows(block, runId)));
  const ended = timing.outcome === "error" || timing.outcome === "cancelled";
  const spoke = Boolean(work.length || after.length || timing.live || ended);
  if (spoke) {
    const writing = after.some((block) => block.kind === "message" && block.role === "assistant" && block.streaming);
    rows.push({ kind: "head", key: `head:${turn.id}`, runId, live: timing.live, writing, startedAt: timing.startedAt, durationMs: timing.durationMs, outcome: timing.outcome });
  }
  if (work.length) {
    const current = turn.blocks.findLast(isLive);
    const now: WorkNow = current?.kind === "message" ? "reply" : (current ?? null);
    rows.push({ kind: "work", key: `work:${turn.id}`, turnId: turn.id, runId, work, live: timing.live, now });
  }
  for (const block of after) {
    // "turn error" and "session error" restate the error card above them.
    if (block.kind === "status" && /^(turn|session) /.test(block.text)) continue;
    rows.push(...afterRows(block, runId));
  }
  const reply = turnReply(after);
  if (spoke && !timing.live && reply) rows.push({ kind: "actions", key: `actions:${turn.id}`, text: reply.text });
  return rows;
}

/** The space above a row in a turn, by the row above it; the turn's first row takes `opening`. */
function gapAbove(row: Unspaced, above: Unspaced | undefined, opening: number): number {
  if (!above) return opening;
  if (row.kind === "actions") return GAP.actions;
  return above.kind === "prompt" ? GAP.prompt : GAP.part;
}

/** A turn's rows with the space above each; `opening` is the space above its first. */
function turnRows(turn: { id: string; blocks: Block[] }, live: boolean, fallbackRunId: string, opening: number): Row[] {
  return turnParts(turn, live, fallbackRunId).map((row, index, rows) => ({ ...row, gap: gapAbove(row, rows[index - 1], opening) }) as Row);
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
export function transcriptRows(blocks: Block[], { live, working }: TranscriptActivity, runId: string, memo: RowMemo): Row[] {
  const turns = workTurns(blocks);
  const next: RowMemo["turns"] = new Map();
  const rows: Row[] = [];
  turns.forEach((turn, index) => {
    const turnLive = live && index === turns.length - 1;
    // A prompt whose answer came as a turn of its own still sits 28 above it.
    const opening = rows.at(-1)?.kind === "prompt" ? GAP.prompt : GAP.turn;
    const previous = memo.turns.get(turn.id);
    if (previous && previous.live === turnLive && previous.opening === opening && sameItems(previous.blocks, turn.blocks)) {
      next.set(turn.id, previous);
      rows.push(...previous.rows);
      return;
    }
    const kept = new Map(previous?.rows.map((row) => [row.key, row]));
    const fresh = turnRows(turn, turnLive, runId, opening).map((row) => {
      const before = kept.get(row.key);
      return before && sameRow(row, before) ? before : row;
    });
    next.set(turn.id, { blocks: turn.blocks, live: turnLive, opening, rows: fresh });
    rows.push(...fresh);
  });
  memo.turns = next;
  if (turns.length) rows.push(presenceRow(memo, working));
  if (sameItems(rows, memo.rows)) return memo.rows;
  memo.rows = rows;
  return rows;
}

/** The agent at the end of the conversation, working while the thread is, the same row object until that changes. */
function presenceRow(memo: RowMemo, working: boolean): Row {
  const last = memo.rows.at(-1);
  return last?.kind === "presence" && last.working === working ? last : { kind: "presence", key: "presence", gap: GAP.part, working };
}

/** The newest row, the one the New chip watches: the agent's presence always ends the list, so it is not news. */
export const newestRow = (rows: Row[]): Row | null => rows.findLast((row) => row.kind !== "presence") ?? null;

/** Question cards still waiting for an answer: they hold picks and typed text, so they stay mounted off screen. */
export function unsentRows(rows: Row[]): string[] {
  return rows.flatMap((row) => (row.kind === "card" && row.block.kind === "approval" && row.block.approvalKind === "user_input" && !row.block.decision ? [row.key] : []));
}

/**
 * Rows that are always this tall below their gap, so the list places them exactly before they draw: a head, the
 * actions (one control) and the agent's presence. Their views take these heights from here.
 */
export const FIXED_HEIGHT = { head: 16, actions: height["control-md"], presence: 36 } as const satisfies Partial<Record<RowKind, number>>;

export function fixedHeight(row: Row): number | undefined {
  const fixed: number | undefined = (FIXED_HEIGHT as Partial<Record<RowKind, number>>)[row.kind];
  return fixed === undefined ? undefined : row.gap + fixed;
}
