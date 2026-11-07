import type { ReactNode } from "react";
import { cloudStartFailure, cloudStartSteps, failureParts, startingInCloud, type StartingCloudThread } from "@openorc/client";
import type { QueuedMessage, ThreadSummary } from "@openorc/protocol";
import { Button } from "./ui";
import { StepMark } from "./WorkSteps";
import { useRpcMutation } from "../lib/client";
import "./CloudStart.css";

export { queueAfterStart } from "@openorc/client";

/** What went wrong in a line, Try again, and what the sandbox printed, such as a daemon's log, only when asked for. */
function Failed({ thread, message, failure }: { thread: StartingCloudThread; message: QueuedMessage; failure: string }) {
  const retry = useRpcMutation("threads.sendQueued");
  const { headline, details } = failureParts(failure);
  return (
    <>
      <div className="text-md text-ink">The cloud workspace did not start</div>
      <p role="alert" className="cloud-start-error">
        {headline}
      </p>
      {details ? (
        <details className="cloud-start-details">
          <summary>Details</summary>
          <pre>{details}</pre>
        </details>
      ) : null}
      <div className="mt-4">
        <Button disabled={retry.isPending} onClick={() => retry.mutate({ id: thread.id, messageId: message.id })}>
          Try again
        </Button>
      </div>
    </>
  );
}

/**
 * A thread that has run before while its sandbox is set up again, as when a message brings back one deleted or failed:
 * the step under way, in one line above the composer, so a slow send says what it waits for. Nothing otherwise.
 */
export function CloudPreparing({ thread }: { thread: StartingCloudThread | null }) {
  if (!thread) return null;
  const steps = cloudStartSteps(thread);
  const current = steps.find((step) => step.state === "running") ?? steps.at(-1)!;
  return (
    <div className="cloud-preparing" role="status" aria-label="Cloud workspace">
      <StepMark state="running" />
      <span className="cloud-preparing-label">{current.label}</span>
      <span className="cloud-preparing-count tabular">
        {steps.indexOf(current) + 1} of {steps.length}
      </span>
    </div>
  );
}

/**
 * A starting cloud thread's card: the sandbox's setup as steps, and the message that goes to the agent once it is
 * ready. Any other thread gets `fallback`.
 */
export function CloudStart({ thread, runs, fallback }: { thread: ThreadSummary | null | undefined; runs: number; fallback: ReactNode }) {
  if (!startingInCloud(thread, runs)) return fallback;
  const message = thread.queued[0]!;
  const failure = cloudStartFailure(thread);
  return (
    <div className="h-full grid place-items-center px-6 py-12">
      <section className="cloud-start" aria-label="Cloud workspace">
        {failure ? (
          <Failed thread={thread} message={message} failure={failure} />
        ) : (
          <>
            <div className="text-md text-ink">Setting up the cloud workspace</div>
            <ol className="cloud-start-steps">
              {cloudStartSteps(thread).map(({ step, label, state }) => (
                <li key={step} data-state={state}>
                  <StepMark state={state} />
                  {label}
                </li>
              ))}
            </ol>
          </>
        )}
        <p className="cloud-start-message">{message.text.trim() || "Attached images"}</p>
      </section>
    </div>
  );
}
