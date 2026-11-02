import type { ReactNode } from "react";
import { harnessShortName, type CloudStep, type CloudThreadState, type QueuedMessage, type ThreadSummary } from "@openorc/protocol";
import { Button } from "./ui";
import { StepMark, type StepState } from "./WorkSteps";
import { useRpcMutation } from "../lib/client";
import "./CloudStart.css";

type Starting = ThreadSummary & { cloud: CloudThreadState };

/** A cloud thread before its first turn: its first message waits in the queue while the sandbox gets ready. */
function starting(thread: ThreadSummary | null | undefined, runs: number): thread is Starting {
  return Boolean(thread?.cloud && runs === 0 && thread.queued.length > 0);
}

/** The queue above the composer, without the first message a starting cloud thread shows in its own card. */
export function queueAfterStart(thread: ThreadSummary, runs: number): QueuedMessage[] {
  return starting(thread, runs) ? thread.queued.slice(1) : thread.queued;
}

type Step = CloudStep | "agent";

function stepLabel(step: Step, thread: Starting): string {
  if (step === "sandbox") return thread.cloud.provider === "vercel" ? "Starting a Vercel sandbox" : "Starting the sandbox";
  if (step === "code") return "Sending your code";
  if (step === "setup") return "Running the setup script";
  return `Starting ${harnessShortName(thread.agent)}`;
}

function stepState(index: number, current: number): StepState {
  if (index < current) return "done";
  return index === current ? "running" : "pending";
}

/** Every step before the current one is done; the agent starts once the sandbox is ready. */
function steps(thread: Starting): { step: Step; state: StepState }[] {
  const order: Step[] = ["sandbox", "code", ...(thread.cloud.setup ? (["setup"] as const) : []), "agent"];
  const current = order.indexOf(thread.cloud.state === "ready" ? "agent" : (thread.cloud.step ?? "sandbox"));
  return order.map((step, index) => ({ step, state: stepState(index, current) }));
}

function Failed({ thread, message }: { thread: Starting; message: QueuedMessage }) {
  const retry = useRpcMutation("threads.sendQueued");
  return (
    <>
      <div className="text-md text-ink">The cloud workspace did not start</div>
      <p role="alert" className="cloud-start-error">
        {thread.cloud.error ?? message.error ?? "Something went wrong while it was being set up."}
      </p>
      <div className="mt-4">
        <Button disabled={retry.isPending} onClick={() => retry.mutate({ id: thread.id, messageId: message.id })}>
          Try again
        </Button>
      </div>
    </>
  );
}

/**
 * A starting cloud thread's card: the sandbox's setup as steps, and the message that goes to the agent once it is
 * ready. Any other thread gets `fallback`.
 */
export function CloudStart({ thread, runs, fallback }: { thread: ThreadSummary | null | undefined; runs: number; fallback: ReactNode }) {
  if (!starting(thread, runs)) return fallback;
  const message = thread.queued[0]!;
  return (
    <div className="h-full grid place-items-center px-6 py-12">
      <section className="cloud-start" aria-label="Cloud workspace">
        {thread.cloud.state === "failed" || message.interrupted ? (
          <Failed thread={thread} message={message} />
        ) : (
          <>
            <div className="text-md text-ink">Setting up the cloud workspace</div>
            <ol className="cloud-start-steps">
              {steps(thread).map(({ step, state }) => (
                <li key={step} data-state={state}>
                  <StepMark state={state} />
                  {stepLabel(step, thread)}
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
