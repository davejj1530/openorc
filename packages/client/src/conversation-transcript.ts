import { useCallback, useEffect, useMemo, useState } from "react";
import type { Run } from "@openorc/protocol";
import type { ClientQueries } from "./query.js";
import type { createRunStore } from "./run-store.js";
import { emptyRun, type Block, type RunTranscript } from "./transcript.js";

type Runs = ReturnType<typeof createRunStore>;

/** Turns a conversation opens with, and how many more each approach to the top brings in. */
const PAGE_TURNS = 4;

/** A place in a conversation to load back to: a run, and the turn of it to load from. */
export type ConversationTarget = { runId: string; turn: number };

/**
 * A thread's runs read as one conversation: their loaded turns in run order, with the thread's own messages placed by
 * time. Paging and the live run follow the same loaded window, whose runs `shown` names, oldest first. A `target`
 * extends the window back to it.
 */
export function useConversationTranscriptWith(queries: ClientQueries, store: Runs, { runs, threadId, target }: { runs: Run[]; threadId: string | null; target?: ConversationTarget | undefined }) {
  const activeRun = runs.at(-1);
  const conversationMessages = queries.useRpc("threads.messages", { id: threadId ?? "" }, { enabled: Boolean(threadId) });
  const { shown, transcripts, hasOlder, loadOlder } = useRecentRuns(store, runs, target);
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
    const blocks = [...parts.flatMap((t) => t.blocks), ...visible];
    // Runs keep their blocks in time order, so only a thread message out of place needs the sort, which took a
    // streaming frame about 2 ms in the iOS simulator once a few long turns were loaded.
    if (!inTimeOrder(blocks)) blocks.sort((a, b) => at(a) - at(b));
    return { ...base, blocks, runId: activeRun?.id ?? base.runId };
  }, [transcripts, hasOlder, activeRun?.id, messages]);

  const liveTranscript = activeRun && shown.at(-1) === activeRun.id ? transcripts.at(-1) : undefined;
  return { merged, transcripts, liveTranscript, hasOlder, loadOlder, shown };
}

const at = (block: Block) => block.at ?? 0;

function inTimeOrder(blocks: Block[]): boolean {
  for (let i = 1; i < blocks.length; i++) if (at(blocks[i]!) < at(blocks[i - 1]!)) return false;
  return true;
}

/**
 * The runs a conversation shows, newest first: the newest run's latest turns to begin with, then older turns and
 * older runs as the reader scrolls toward them. Returning within a few minutes shows as much as was loaded before.
 */
function useRecentRuns(store: Runs, runs: Run[], target: ConversationTarget | undefined) {
  const runStore = store.runs;
  const ids = useMemo(() => runs.map((run) => run.id), [runs]);
  const [shownFrom, setShownFrom] = useState<string | null>(null);
  const failed = store.useFailedLoads();
  const start = shownFrom !== null && ids.includes(shownFrom) ? ids.indexOf(shownFrom) : loadedFrom(runStore, ids);
  const shown = useMemo(() => ids.slice(start), [ids, start]);
  const transcripts = store.useRuns(shown);
  const first = transcripts[0];
  // Still loading counts as more to come, so nothing older is shown out of place meanwhile. A run that failed to
  // load shows what arrived live instead.
  const loading = shown[0] !== undefined && !first?.hydrated && !failed.has(shown[0]);
  const hasOlder = start > 0 || loading || Boolean(first?.hydrated && first.fromTurn > 0);

  // A target's run loads from the turn before it, so what led there shows above it, and every later run loads whole,
  // so nothing is missing between it and the newest turn. Ahead of the usual first page, which then finds these
  // loads covering it.
  const targetIndex = target ? ids.indexOf(target.runId) : -1;
  useEffect(() => {
    if (!target || targetIndex < 0) return;
    if (targetIndex < start) setShownFrom(target.runId);
    ids.slice(targetIndex).forEach((id, i) => {
      runStore.hydrate(id, { fromTurn: i === 0 ? Math.max(0, target.turn - 1) : 0 }).catch(() => undefined);
    });
  }, [target, targetIndex, start, ids, runStore]);

  // Where the view begins stays put once its first run is here: a run that starts later joins the end instead of
  // taking the view over, and only the reader scrolling up moves the start back.
  useEffect(() => {
    const begin = shown[0];
    if (begin && first?.hydrated) setShownFrom((pinned) => (pinned !== null && ids.includes(pinned) ? pinned : begin));
  }, [shown, ids, first]);

  useEffect(() => {
    // Every shown run reads its turns from the ledger once, a live one too; frames that arrive meanwhile follow.
    for (const id of shown) {
      if (runStore.get(id)?.hydrated || failed.has(id)) continue;
      runStore.hydrate(id, { turns: PAGE_TURNS }).catch(() => undefined);
    }
  }, [runStore, shown, transcripts, failed]);

  const loadOlder = useCallback(() => {
    const id = shown[0];
    const oldest = id ? runStore.get(id) : undefined;
    if (!id || !oldest?.hydrated) return;
    if (oldest.fromTurn > 0) runStore.hydrate(id, { fromTurn: Math.max(0, oldest.fromTurn - PAGE_TURNS) }).catch(() => undefined);
    else if (start > 0) setShownFrom(ids[start - 1]!);
  }, [runStore, shown, start, ids]);

  return { shown, transcripts, hasOlder, loadOlder };
}

/** Where to start showing runs: the newest, extended back over runs still loaded in full from an earlier visit. */
function loadedFrom(runStore: Runs["runs"], ids: string[]): number {
  const whole = (id: string) => {
    const run = runStore.get(id);
    return Boolean(run?.hydrated && run.fromTurn === 0);
  };
  let start = Math.max(0, ids.length - 1);
  while (start > 0 && whole(ids[start]!) && runStore.get(ids[start - 1]!)?.hydrated) start--;
  return start;
}
