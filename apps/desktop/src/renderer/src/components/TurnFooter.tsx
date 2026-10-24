import { useCallback, useState, type ReactNode } from "react";
import { ChangeCard, fileCount } from "./ChangeCard";
import { ThreadChangeCard, UndoTurnButton } from "./ThreadChangeCard";
import { useRpc } from "../lib/client";
import { useLayout } from "../lib/layout";
import type { Block } from "@openorc/client";
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
