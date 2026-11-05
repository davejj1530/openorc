import {
  harnessShortName,
  isHarnessId,
  NOT_ON_BRAIN,
  WORKSPACE_ID,
  type CloudOffer,
  type CloudStep,
  type CloudThreadState,
  type AgentKind,
  type MoveStep,
  type QueuedMessage,
  type ThreadSummary,
} from "@openorc/protocol";

/** Every agent runs in a cloud sandbox; the reserved ACP kind has no adapter anywhere. */
export function runsInCloud(agent: AgentKind | null | undefined): boolean {
  return isHarnessId(agent);
}

/** A conversation on this Mac that can move to a sandbox of its own: a project's, not a team's, with an agent that runs there. */
export function canMoveToCloud(thread: ThreadSummary): boolean {
  return !thread.cloud && !thread.teamInstanceId && thread.projectId !== WORKSPACE_ID && runsInCloud(thread.agent);
}

/** Move to cloud with a cloud brain set up: offered for a project's conversation this host holds. The brain checks again when asked. */
export function offersBrainMove(thread: ThreadSummary): boolean {
  return !thread.owner && !thread.moving && !thread.teamInstanceId && thread.projectId !== WORKSPACE_ID && thread.parentRelation !== "subagent";
}

/**
 * Why a new thread on this project can't start in the cloud, or null. With a cloud brain set up, a cloud thread starts on
 * the brain, so only on a project it has a copy of; without one, in a sandbox of its own.
 */
export function cloudStartBlocked(offer: Pick<CloudOffer, "brain"> | undefined, projectId: string): string | null {
  const brain = offer?.brain;
  return brain && !brain.projects.some((project) => project.mac === projectId) ? NOT_ON_BRAIN : null;
}

/** The quiet word a row shows for where it lives, dimmed while its owner cannot be reached; null for this host's own. */
export function ownerMark(thread: Pick<ThreadSummary, "owner" | "moving">): { label: "Moving" | "Cloud" | "Mac asleep"; dim: boolean } | null {
  if (thread.moving) return { label: "Moving", dim: false };
  if (!thread.owner) return null;
  if (thread.owner.brain === "cloud") return { label: "Cloud", dim: thread.owner.reach !== "live" };
  return thread.owner.reach === "live" ? null : { label: "Mac asleep", dim: true };
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

const MOVE_ORDER: Record<"mac" | "cloud", MoveStep[]> = { cloud: ["packing", "waking", "sending"], mac: ["waking", "packing", "sending"] };
const MOVE_LABELS: Record<"mac" | "cloud", Record<MoveStep, string>> = {
  cloud: { packing: "Packing the conversation", waking: "Waking the cloud brain", sending: "Sending it to the cloud" },
  mac: { waking: "Waking the cloud brain", packing: "Packing it in the cloud", sending: "Bringing it to this Mac" },
};

/** The card a conversation shows about a move: its steps while it moves or its brain wakes, or why the last one did not happen. */
export type MoveCard =
  | { kind: "moving"; title: string | null; steps: { step: MoveStep; label: string; state: CloudStartStepState }[] }
  | { kind: "refused"; title: "Didn't move"; reason: string; retry: "cloud.move" | "cloud.bringToMac" };

/**
 * The quiet card on a conversation while it moves between this Mac and the cloud brain, or while the brain it lives on
 * wakes, or after a move this Mac asked for was refused, until it is tried again or the conversation does something
 * else; null otherwise. A move whose step is not known yet is at its first.
 */
export function threadMoveCard(thread: Pick<ThreadSummary, "moving" | "owner" | "moveRefused" | "lastActivityAt">): MoveCard | null {
  const moving = thread.moving;
  const refused = thread.moveRefused;
  if (!moving && refused && thread.lastActivityAt <= refused.at)
    return { kind: "refused", title: "Didn't move", reason: refused.reason, retry: refused.to === "cloud" ? "cloud.move" : "cloud.bringToMac" };
  if (!moving) {
    if (thread.owner?.brain !== "cloud" || thread.owner.reach !== "waking") return null;
    return { kind: "moving", title: null, steps: [{ step: "waking", label: "Waking the cloud brain", state: "running" }] };
  }
  const order = MOVE_ORDER[moving.to];
  const current = Math.max(0, order.indexOf(moving.step ?? order[0]!));
  return {
    kind: "moving",
    title: moving.to === "cloud" ? "Moving to the cloud" : "Moving to this Mac",
    steps: order.map((step, index) => ({ step, label: MOVE_LABELS[moving.to][step], state: stepState(index, current) })),
  };
}
