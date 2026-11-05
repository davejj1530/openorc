import { threadMoveCard, type MoveCard } from "@openorc/client";
import type { ThreadSummary } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { Button } from "./ui";
import { StepMark } from "./WorkSteps";
import "./CloudStart.css";

const card = "rounded-xl bg-surface px-3.5 py-1.5 text-base";

/** Why the move this Mac asked for did not happen; Try again asks for it again, while there is a brain to ask. */
function Refused({ threadId, refused }: { threadId: string; refused: Extract<MoveCard, { kind: "refused" }> }) {
  const brain = Boolean(useRpc("cloud.offer", {}).data?.brain);
  const retry = useRpcMutation(refused.retry);
  return (
    <section role="status" aria-label={refused.title} data-plane className={card}>
      <div className="pt-1.5 text-ink">{refused.title}</div>
      <p className="py-1 text-ink-3">{retry.error?.message ?? refused.reason}</p>
      {brain ? (
        <div className="pb-1.5">
          <Button variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate({ threadId })}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A conversation moving between this Mac and the cloud brain, or waiting while its brain wakes: the steps, quietly. Or
 * the move this Mac asked for that did not happen, until it is tried again or the conversation does something else.
 */
export function ThreadMoveCard({ thread }: { thread: ThreadSummary | null }) {
  const shown = thread && threadMoveCard(thread);
  if (!shown) return null;
  if (shown.kind === "refused") return <Refused threadId={thread.id} refused={shown} />;
  return (
    <section role="status" aria-label={shown.title ?? "Cloud brain"} data-plane className={card}>
      {shown.title ? <div className="pt-1.5 text-ink">{shown.title}</div> : null}
      <ol className="cloud-start-steps">
        {shown.steps.map(({ step, label, state }) => (
          <li key={step} data-state={state}>
            <StepMark state={state} />
            {label}
          </li>
        ))}
      </ol>
    </section>
  );
}
