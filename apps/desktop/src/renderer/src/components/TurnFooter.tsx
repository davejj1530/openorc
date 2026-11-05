import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ChangeCard, fileCount } from "./ChangeCard";
import { ThreadChangeCard, UndoTurnButton } from "./ThreadChangeCard";
import { useRpc, useRpcs } from "../lib/client";
import { useLayout } from "../lib/layout";
import type { Block, TurnSize } from "@openorc/client";
import type { OutsideLine, TurnFooters } from "../lib/turn-footers";

/** How each kind of outside change reads. `unknown` stays neutral: an agent may have made some of the changes. */
const OUTSIDE_WORDING: Record<OutsideLine["by"], { heading: (count: number) => string; label: string; hint: string; confirmHint: string }> = {
  user: {
    heading: (count) => `You changed ${fileCount(count)}`,
    label: "Undo your changes",
    hint: "Put the files back as they were after the last turn.",
    confirmHint: "Click again to put the files back as they were after the last turn.",
  },
  unknown: {
    heading: (count) => `${fileCount(count)} changed between turns`,
    label: "Undo the changes between turns",
    hint: "Put the files back as they were after the last turn, including changes from other conversations.",
    confirmHint: "Click again to put the files back as they were after the last turn, including changes from other conversations.",
  },
};

/** The size each turn's change card reads, by the turn's blocks, for its receipt. */
const TurnSizes = createContext<(blocks: Block[]) => TurnSize | null>(() => null);

const sizeOf = (files: { added: number | null; removed: number | null }[]): TurnSize => ({
  files: files.length,
  added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
  removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
});

/**
 * Reads each loaded turn's saved change once, the same read its change card makes, so a turn's receipt can say
 * "+21 −8 in 3 files". The lookup only changes when a size does, so streaming leaves finished turns alone.
 */
export function TurnChangesProvider({ footers, threadId, children }: { footers: TurnFooters; threadId: string | undefined; children: ReactNode }) {
  const cards = [...footers.cards.values()];
  const summaries = useRpcs(
    "threads.turnChanges",
    cards.map((card) => ({ id: threadId ?? "", checkpointId: card.checkpointId })),
    { enabled: Boolean(threadId), staleTime: Infinity },
  );
  const sizes = cards.flatMap((card, index) => {
    const files = summaries[index]?.data?.files;
    return files ? [[card.checkpointId, sizeOf(files)] as const] : [];
  });
  const key = JSON.stringify(sizes);
  const lookup = useMemo(() => {
    const byCheckpoint = new Map<string, TurnSize>(JSON.parse(key) as [string, TurnSize][]);
    return (blocks: Block[]) => {
      const card = blocks.map((block) => footers.cards.get(block.id)).find((found) => found !== undefined);
      return card ? (byCheckpoint.get(card.checkpointId) ?? null) : null;
    };
  }, [footers, key]);
  return <TurnSizes.Provider value={lookup}>{children}</TurnSizes.Provider>;
}

/** "+21 −8 in 3 files" for a turn's receipt, once the conversation has read its saved change. */
export function useTurnSize(blocks: Block[]): TurnSize | null {
  return useContext(TurnSizes)(blocks);
}

/** What follows a turn in the transcript: its change card, then a line for files changed before the next turn began. */
export function useTurnFooter({ footers, threadId, working }: { footers: TurnFooters; threadId: string | undefined; working: boolean }): (blocks: Block[]) => ReactNode {
  return useCallback(
    (blocks: Block[]) => {
      const card = blocks.map((block) => footers.cards.get(block.id)).find((found) => found !== undefined);
      const lines = blocks.flatMap((block) => footers.outside.get(block.id) ?? []);
      if (!threadId || (!card && !lines.length)) return null;
      return (
        <>
          {card ? <ThreadChangeCard key={card.checkpointId} threadId={threadId} {...card} working={working} /> : null}
          {lines.map((line) => (
            <OutsideChangesLine key={line.checkpointId} line={line} threadId={threadId} working={working} />
          ))}
        </>
      );
    },
    [footers, threadId, working],
  );
}

/**
 * Files changed between two turns, by the reader or by someone the core could not rule out. The files stay folded:
 * the line reads quieter than an agent's card. Undo returns the files to where the last turn left them.
 */
function OutsideChangesLine({ line, threadId, working }: { line: OutsideLine; threadId: string; working: boolean }) {
  const openReview = useLayout((state) => state.openChanges);
  const summary = useRpc("threads.turnChanges", { id: threadId, checkpointId: line.checkpointId }, { staleTime: Infinity });
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const files = summary.data?.files ?? [];
  // Unlike a turn, there are no tool calls to name the files before the saved diff is read.
  if (files.length === 0) return null;
  const wording = OUTSIDE_WORDING[line.by];
  return (
    <ChangeCard
      files={files}
      counted
      heading={wording.heading(files.length)}
      folded
      error={restoreError}
      onReview={(selected) => openReview({ kind: "thread", id: threadId, checkpointId: line.checkpointId, paths: selected })}
      actions={
        <UndoTurnButton
          threadId={threadId}
          checkpointId={line.previousCheckpointId}
          working={working}
          label={wording.label}
          hint={wording.hint}
          confirmHint={wording.confirmHint}
          onError={setRestoreError}
        />
      }
    />
  );
}
