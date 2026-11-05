import { threadMoveCard } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { StepMark } from "./WorkSteps";
import "./CloudStart.css";

/** A conversation moving between this Mac and the cloud brain, or waiting while its brain wakes: the steps, quietly. */
export function ThreadMoveCard({ thread }: { thread: ThreadSummary | null }) {
  const card = thread && threadMoveCard(thread);
  if (!card) return null;
  return (
    <section role="status" aria-label={card.title ?? "Cloud brain"} data-plane className="rounded-xl bg-surface px-3.5 py-1.5 text-base">
      {card.title ? <div className="pt-1.5 text-ink">{card.title}</div> : null}
      <ol className="cloud-start-steps">
        {card.steps.map(({ step, label, state }) => (
          <li key={step} data-state={state}>
            <StepMark state={state} />
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
}
