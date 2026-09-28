import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Run } from "@openorc/protocol";
import { useRpc } from "./query";
import { editedPaths } from "./edited-paths";
import { emptyRun, getRun, hydrate, useRuns, type Block, type RunTranscript } from "./transcript";

/** Paging, conversation messages and checkpoint placement follow the same loaded run window. */
export function useConversationTranscript({ runs, threadId, basePath }: { runs: Run[]; threadId: string | null; basePath: string }) {
  const activeRun = runs.at(-1);
  const conversationMessages = useRpc("threads.messages", { id: threadId ?? "" }, { enabled: Boolean(threadId) });
  const { shown, transcripts, hasOlder, loadOlder } = useRecentRuns(runs);
  const messages = useMemo(
    () =>
      (conversationMessages.data ?? []).map((m): Block => ({
        id: m.id,
        kind: "message",
        role: m.role,
        text: m.text,
        at: m.createdAt,
        attachments: m.attachments,
        streaming: false,
        turnKey: `conversation:${m.id}`,
      })),
    [conversationMessages.data],
  );
  const merged = useMemo(() => {
    // One transcript across runs: blocks in run order, so a thread reads as a single conversation.
    const parts = transcripts.filter((t): t is RunTranscript => Boolean(t));
    const last = parts[parts.length - 1];
    // Thread messages older than the loaded turns wait for them, rather than gathering above.
    const since = hasOlder ? parts[0]?.blocks[0]?.at : undefined;
    let visible = messages;
    if (since !== undefined) visible = messages.filter((message) => (message.at ?? 0) >= since);
    else if (hasOlder) visible = [];
    if (!last && !visible.length) return null;
    const base = last ?? { ...emptyRun(""), hydrated: true };
    // Blocks carry their run from the store, so a fork can branch from the message the user points at.
    const blocks = [...parts.flatMap((t) => t.blocks), ...visible].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return { ...base, blocks, runId: activeRun?.id ?? base.runId };
  }, [transcripts, hasOlder, activeRun?.id, messages]);

  // Each turn that saved a checkpoint gets a change card after its last block. A
  // checkpoint's turn number is one-based; a block's turn is how many had finished before it.
  const checkpoints = useRpc("threads.checkpoints", { id: threadId ?? "" }, { enabled: Boolean(threadId) });
  const computedCards = useMemo(() => {
    const cards = new Map<string, TurnCard>();
    const history = checkpoints.data;
    if (!threadId || !history) return cards;
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
  }, [threadId, checkpoints.data, transcripts, basePath]);
  // Streaming changes the transcript on every frame but the cards only when a turn ends; finished turns stay memoized.
  const turnCards = useSameCards(computedCards);

  const liveTranscript = activeRun && shown.at(-1) === activeRun.id ? transcripts.at(-1) : undefined;
  return { merged, liveTranscript, turnCards, hasOlder, loadOlder };
}

type TurnCard = { checkpointId: string; previousCheckpointId: string | null; paths: string[] };

/** The previous map while its cards are unchanged, so what depends on it keeps its identity. */
function useSameCards(cards: Map<string, TurnCard>): Map<string, TurnCard> {
  const previous = useRef(cards);
  const same = (a: TurnCard, b: TurnCard | undefined) =>
    Boolean(b && a.checkpointId === b.checkpointId && a.previousCheckpointId === b.previousCheckpointId && a.paths.join("\n") === b.paths.join("\n"));
  if (cards.size !== previous.current.size || [...cards].some(([id, card]) => !same(card, previous.current.get(id)))) previous.current = cards;
  return previous.current;
}

/** Turns a conversation opens with, and how many more each approach to the top brings in. */
const PAGE_TURNS = 4;

/**
 * The runs a conversation shows, newest first: the newest run's latest turns to begin with, then older turns and
 * older runs as the reader scrolls toward them. Returning within a few minutes shows as much as was loaded before.
 */
function useRecentRuns(runs: Run[]) {
  const ids = useMemo(() => runs.map((run) => run.id), [runs]);
  const [shownFrom, setShownFrom] = useState<string | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const start = shownFrom !== null && ids.includes(shownFrom) ? ids.indexOf(shownFrom) : loadedFrom(ids);
  const shown = useMemo(() => ids.slice(start), [ids, start]);
  const transcripts = useRuns(shown);
  const first = transcripts[0];
  // Still loading counts as more to come, so nothing older is shown out of place meanwhile. A run that failed to
  // load shows what arrived live instead.
  const loading = shown[0] !== undefined && !first?.hydrated && !failed.has(shown[0]);
  const hasOlder = start > 0 || loading || Boolean(first?.hydrated && first.fromTurn > 0);

  // Where the view begins stays put once its first run is here: a run that starts later joins the end instead of
  // taking the view over, and only the reader scrolling up moves the start back.
  useEffect(() => {
    const begin = shown[0];
    if (begin && first?.hydrated) setShownFrom((pinned) => (pinned !== null && ids.includes(pinned) ? pinned : begin));
  }, [shown, ids, first]);

  useEffect(() => {
    // Every shown run reads its turns from the ledger once, a live one too; frames that arrive meanwhile follow.
    for (const id of shown) {
      if (getRun(id)?.hydrated || failed.has(id)) continue;
      hydrate(id, { turns: PAGE_TURNS }).catch(() => setFailed((ids) => new Set(ids).add(id)));
    }
  }, [shown, transcripts, failed]);

  const loadOlder = useCallback(() => {
    const id = shown[0];
    const oldest = id ? getRun(id) : undefined;
    if (!id || !oldest?.hydrated) return;
    if (oldest.fromTurn > 0) hydrate(id, { fromTurn: Math.max(0, oldest.fromTurn - PAGE_TURNS) }).catch(() => setFailed((ids) => new Set(ids).add(id)));
    else if (start > 0) setShownFrom(ids[start - 1]!);
  }, [shown, start, ids]);

  return { shown, transcripts, hasOlder, loadOlder };
}

/** Where to start showing runs: the newest, extended back over runs still loaded in full from an earlier visit. */
function loadedFrom(ids: string[]): number {
  const whole = (id: string) => {
    const run = getRun(id);
    return Boolean(run?.hydrated && run.fromTurn === 0);
  };
  let start = Math.max(0, ids.length - 1);
  while (start > 0 && whole(ids[start]!) && getRun(ids[start - 1]!)?.hydrated) start--;
  return start;
}
