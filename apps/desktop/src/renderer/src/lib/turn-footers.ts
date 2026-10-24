import { useMemo, useRef } from "react";
import type { ThreadCheckpoint } from "@openorc/protocol";
import { editedPaths, type Block, type RunTranscript } from "@openorc/client";
import { useRpc } from "./client";

export type TurnCard = { checkpointId: string; previousCheckpointId: string | null; paths: string[] };

/** A checkpoint saved as a turn started, drawn as one line between turns with its own Undo. */
export interface OutsideLine {
  checkpointId: string;
  /** Undo restores this one: the checkpoint before the outside changes, which is where the last turn left the files. */
  previousCheckpointId: string;
  by: NonNullable<ThreadCheckpoint["outside"]>;
}

/** What follows a block: its turn's change card, then any outside-changes lines captured right after it. */
export interface TurnFooters {
  cards: Map<string, TurnCard>;
  outside: Map<string, OutsideLine[]>;
}

/** The change cards and outside-changes lines for the turns a conversation has loaded, placed by its checkpoints. */
export function useTurnFooters({
  threadId,
  transcripts,
  blocks,
  basePath,
}: {
  threadId: string | null;
  transcripts: readonly (RunTranscript | undefined)[];
  blocks: readonly Block[] | undefined;
  basePath: string;
}): TurnFooters {
  const checkpoints = useRpc("threads.checkpoints", { id: threadId ?? "" }, { enabled: Boolean(threadId) });
  const history = threadId ? checkpoints.data : undefined;
  const computed = useMemo((): TurnFooters => {
    if (!history) return { cards: new Map(), outside: new Map() };
    return { cards: turnCards(history, transcripts, basePath), outside: outsideLines(history, transcripts, blocks ?? []) };
  }, [history, transcripts, blocks, basePath]);
  // Streaming changes the transcript on every frame but the footers only when a turn ends; finished turns stay memoized.
  return useSameFooters(computed);
}

/**
 * Each turn that saved a checkpoint gets a change card after its last block. A checkpoint's turn number is
 * one-based; a block's turn is how many had finished before it.
 */
function turnCards(history: ThreadCheckpoint[], transcripts: readonly (RunTranscript | undefined)[], basePath: string): Map<string, TurnCard> {
  const cards = new Map<string, TurnCard>();
  for (const t of transcripts) {
    if (!t) continue;
    for (let turn = t.fromTurn; turn < t.turnsCompleted; turn++) {
      const index = history.findIndex((c) => c.runId === t.runId && c.turn === turn + 1);
      if (index < 0) continue;
      let last: string | null = null;
      const paths: string[] = [];
      for (const block of t.blocks) {
        if (t.turnOf.get(block.id) !== turn) continue;
        last = block.id;
        if (block.kind === "tool") paths.push(...editedPaths(block.name, block.input, basePath));
      }
      if (last) cards.set(last, { checkpointId: history[index]!.id, previousCheckpointId: index > 0 ? history[index - 1]!.id : null, paths: [...new Set(paths)] });
    }
  }
  return cards;
}

/** Each checkpoint saved for files changed between turns gets a line after the turn it followed. */
function outsideLines(history: ThreadCheckpoint[], transcripts: readonly (RunTranscript | undefined)[], blocks: readonly Block[]): Map<string, OutsideLine[]> {
  const lines = new Map<string, OutsideLine[]>();
  if (!history.some((row) => row.outside)) return lines;
  const prompts = turnPrompts(transcripts);
  const anchors = blocks.map((block) => ({ id: block.id, at: block.at ?? 0, startsTurn: prompts.has(block.id) }));
  history.forEach((row, index) => {
    const previous = history[index - 1];
    if (!row.outside || !previous) return;
    const anchor = outsideAnchor(anchors, row.createdAt);
    if (anchor) lines.set(anchor, [...(lines.get(anchor) ?? []), { checkpointId: row.id, previousCheckpointId: previous.id, by: row.outside }]);
  });
  return lines;
}

/**
 * The messages that open a turn of their run, as opposed to one steering a turn already running: each turn's first
 * message, unless the agent wrote it. The core records a prompt from the user or the system the same way.
 */
function turnPrompts(transcripts: readonly (RunTranscript | undefined)[]): Set<string> {
  const prompts = new Set<string>();
  for (const t of transcripts) {
    if (!t) continue;
    const opened = new Set<number | undefined>();
    for (const block of t.blocks) {
      const turn = t.turnOf.get(block.id);
      if (block.kind !== "message" || opened.has(turn)) continue;
      opened.add(turn);
      if (block.role !== "assistant") prompts.add(block.id);
    }
  }
  return prompts;
}

/**
 * The block an outside-changes line follows. The capture runs after the turn's prompt is recorded when a new process
 * starts, and before it when a live process takes the message, so wall-clock order alone would sometimes put the
 * line after the prompt. The rule: the last block captured before it, stepping back over a prompt that starts a turn.
 * No agent block of the new turn can precede the capture: the provider receives the prompt after it.
 * Null when that block isn't loaded (an older page); the line shows once the reader scrolls to it.
 */
export function outsideAnchor(blocks: readonly { id: string; at: number; startsTurn: boolean }[], capturedAt: number): string | null {
  let i = blocks.findLastIndex((block) => block.at < capturedAt);
  if (i >= 0 && blocks[i]!.startsTurn) i -= 1;
  return i >= 0 ? blocks[i]!.id : null;
}

/** The previous footers while nothing in them changed, so what depends on them keeps its identity. */
function useSameFooters(footers: TurnFooters): TurnFooters {
  const previous = useRef(footers);
  const sameCard = (a: TurnCard, b: TurnCard | undefined) =>
    Boolean(b && a.checkpointId === b.checkpointId && a.previousCheckpointId === b.previousCheckpointId && a.paths.join("\n") === b.paths.join("\n"));
  const sameLines = (a: OutsideLine[], b: OutsideLine[] | undefined) =>
    Boolean(b && a.length === b.length && a.every((line, i) => line.checkpointId === b[i]!.checkpointId && line.previousCheckpointId === b[i]!.previousCheckpointId && line.by === b[i]!.by));
  if (!sameEntries(footers.cards, previous.current.cards, sameCard) || !sameEntries(footers.outside, previous.current.outside, sameLines)) previous.current = footers;
  return previous.current;
}

function sameEntries<T>(next: Map<string, T>, before: Map<string, T>, same: (a: T, b: T | undefined) => boolean): boolean {
  return next.size === before.size && [...next].every(([id, value]) => same(value, before.get(id)));
}
