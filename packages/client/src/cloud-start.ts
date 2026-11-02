import { harnessShortName, WORKSPACE_ID, type CloudStep, type CloudThreadState, type AgentKind, type QueuedMessage, type ThreadSummary } from "@openorc/protocol";

/** The agents that run in a cloud sandbox so far. */
export function runsInCloud(agent: AgentKind | null | undefined): boolean {
  return agent === "claude" || agent === "codex";
}

/** A conversation on this Mac that can move to a sandbox of its own: a project's, not a team's, with an agent that runs there. */
export function canMoveToCloud(thread: ThreadSummary): boolean {
  return !thread.cloud && !thread.teamInstanceId && thread.projectId !== WORKSPACE_ID && runsInCloud(thread.agent);
}

/** A cloud thread before its first turn, with its cloud state. */
export type StartingCloudThread = ThreadSummary & { cloud: CloudThreadState };

/** A cloud thread before its first turn: its first message waits in the queue while the sandbox gets ready. */
export function startingInCloud(thread: ThreadSummary | null | undefined, runs: number): thread is StartingCloudThread {
  return Boolean(thread?.cloud && runs === 0 && thread.queued.length > 0);
}

/** The queue above the composer, without the first message a starting cloud thread shows in its own card. */
export function queueAfterStart(thread: ThreadSummary, runs: number): QueuedMessage[] {
  return startingInCloud(thread, runs) ? thread.queued.slice(1) : thread.queued;
}

export type CloudStartStep = CloudStep | "agent";
export type CloudStartStepState = "pending" | "running" | "done";

function stepLabel(step: CloudStartStep, thread: StartingCloudThread): string {
  if (step === "sandbox") return thread.cloud.provider === "vercel" ? "Starting a Vercel sandbox" : "Starting the sandbox";
  if (step === "code") return "Sending your code";
  if (step === "setup") return "Running the setup script";
  return `Starting ${harnessShortName(thread.agent)}`;
}

function stepState(index: number, current: number): CloudStartStepState {
  if (index < current) return "done";
  return index === current ? "running" : "pending";
}

/** The sandbox's setup as steps: every step before the current one is done; the agent starts once the sandbox is ready. */
export function cloudStartSteps(thread: StartingCloudThread): { step: CloudStartStep; label: string; state: CloudStartStepState }[] {
  const order: CloudStartStep[] = ["sandbox", "code", ...(thread.cloud.setup ? (["setup"] as const) : []), "agent"];
  const current = order.indexOf(thread.cloud.state === "ready" ? "agent" : (thread.cloud.step ?? "sandbox"));
  return order.map((step, index) => ({ step, label: stepLabel(step, thread), state: stepState(index, current) }));
}

/** Why a starting cloud thread's setup failed, or null while it has not; its waiting message is sent again to retry. */
export function cloudStartFailure(thread: StartingCloudThread): string | null {
  const message = thread.queued[0];
  if (thread.cloud.state !== "failed" && !message?.interrupted) return null;
  return thread.cloud.error ?? message?.error ?? "Something went wrong while it was being set up.";
}

/** Where a cloud thread runs, for a line of facts about it. */
export function cloudPlaceLabel(cloud: CloudThreadState): string {
  if (cloud.state === "removed") return "Sandbox removed";
  return cloud.provider === "vercel" ? "Vercel Sandbox" : "Simulated sandbox";
}
