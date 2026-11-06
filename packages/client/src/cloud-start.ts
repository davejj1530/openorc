import {
  DEFAULT_CLAUDE_ACCOUNT,
  harnessShortName,
  isHarnessId,
  NO_CLOUD_SERVICE,
  NOT_ON_BRAIN,
  OPENCODE_FREE_PROVIDER,
  openCodeProvider,
  openCodeProviderName,
  WORKSPACE_ID,
  type CloudOffer,
  type CloudSignIn,
  type CloudSignIns,
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
export function cloudStartBlocked(offer: Pick<CloudOffer, "brain" | "provider"> | Pick<CloudOffer, "brain"> | undefined, projectId: string): string | null {
  const brain = offer?.brain;
  if (brain) return brain.projects.some((project) => project.mac === projectId) ? null : NOT_ON_BRAIN;
  return cloudServiceMissing(offer);
}

/** Why nothing can go to the cloud yet: no brain to take it, and no service connected for a sandbox of its own. */
export function cloudServiceMissing(offer: Pick<CloudOffer, "brain" | "provider"> | Pick<CloudOffer, "brain"> | undefined): string | null {
  return offer && !offer.brain && "provider" in offer && offer.provider === null ? NO_CLOUD_SERVICE : null;
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

/** What a cloud start's steps and failure read from its thread. */
export type CloudStartThread = Pick<ThreadSummary, "agent" | "owner" | "queued"> & { cloud: CloudThreadState };

/** A cloud thread before its first turn: its first message waits in the queue while the sandbox gets ready. */
export function startingInCloud(thread: ThreadSummary | null | undefined, runs: number): thread is StartingCloudThread {
  return Boolean(thread?.cloud && runs === 0 && thread.queued.length > 0);
}

/** The queue above the composer, without the first message a starting cloud thread shows in its own card. */
export function queueAfterStart(thread: ThreadSummary, runs: number): QueuedMessage[] {
  return startingInCloud(thread, runs) ? thread.queued.slice(1) : thread.queued;
}

export type CloudStartStep = "brain" | CloudStep | "agent";
export type CloudStartStepState = "pending" | "running" | "done";

const sandboxStart: Record<CloudThreadState["provider"], string> = { vercel: "Starting a Vercel sandbox", agent37: "Starting an Agent37 instance", local: "Starting the sandbox" };
const brainStart: Record<NonNullable<CloudThreadState["brain"]>, string> = { waking: "Waking the cloud brain", updating: "Updating the cloud brain" };

function stepLabel(step: CloudStartStep, thread: CloudStartThread): string {
  if (step === "brain") return brainStart[thread.cloud.brain ?? "waking"];
  if (step === "sandbox") return sandboxStart[thread.cloud.provider];
  if (step === "code") return "Sending your code";
  if (step === "setup") return "Running the setup script";
  return `Starting ${harnessShortName(thread.agent)}`;
}

function stepState(index: number, current: number): CloudStartStepState {
  if (index < current) return "done";
  return index === current ? "running" : "pending";
}

function currentStep(cloud: CloudThreadState): CloudStartStep {
  if (cloud.brain) return "brain";
  return cloud.state === "ready" ? "agent" : (cloud.step ?? "sandbox");
}

/**
 * The sandbox's setup as steps: every step before the current one is done; the agent starts once the sandbox is ready. A
 * thread on the cloud brain first has the brain woken, and updated when this Mac carries a newer one.
 */
export function cloudStartSteps(thread: CloudStartThread): { step: CloudStartStep; label: string; state: CloudStartStepState }[] {
  const order: CloudStartStep[] = [...(thread.owner?.brain === "cloud" ? (["brain"] as const) : []), "sandbox", "code", ...(thread.cloud.setup ? (["setup"] as const) : []), "agent"];
  const current = order.indexOf(currentStep(thread.cloud));
  return order.map((step, index) => ({ step, label: stepLabel(step, thread), state: stepState(index, current) }));
}

/**
 * Why a starting cloud thread's setup failed, or null while it has not, or while it is set up again: a retry shows its
 * steps, not the failure before it. Its waiting message is sent again to retry.
 */
export function cloudStartFailure(thread: CloudStartThread): string | null {
  const message = thread.queued[0];
  if (thread.cloud.state === "preparing") return null;
  if (thread.cloud.state !== "failed" && !message?.interrupted) return null;
  return thread.cloud.error ?? message?.error ?? "Something went wrong while it was being set up.";
}

/** A cloud thread that has run before, its sandbox being set up again, as when a message brings back one deleted or failed; else null. */
export function preparingCloud(thread: ThreadSummary | null | undefined, runs: number): StartingCloudThread | null {
  return thread?.cloud && runs > 0 && thread.cloud.state === "preparing" ? (thread as StartingCloudThread) : null;
}

/** A failure's first line, what went wrong, apart from what follows it, such as a daemon's log, shown on demand. */
export function failureParts(text: string): { headline: string; details: string | null } {
  const [first = "", ...rest] = text.trim().split("\n");
  return { headline: first.trim(), details: rest.join("\n").trim() || null };
}

const placeLabels: Record<CloudThreadState["provider"], string> = { vercel: "Vercel Sandbox", agent37: "Agent37 instance", local: "Simulated sandbox" };

/** Where a cloud thread runs, for a line of facts about it. */
export function cloudPlaceLabel(cloud: CloudThreadState): string {
  if (cloud.state === "removed") return "Sandbox removed";
  return placeLabels[cloud.provider];
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
export function threadMoveCard(thread: Pick<ThreadSummary, "moving" | "owner" | "moveRefused" | "lastActivityAt" | "cloud">): MoveCard | null {
  const moving = thread.moving;
  const refused = thread.moveRefused;
  if (!moving && refused && thread.lastActivityAt <= refused.at)
    return { kind: "refused", title: "Didn't move", reason: refused.reason, retry: refused.to === "cloud" ? "cloud.move" : "cloud.bringToMac" };
  if (!moving) {
    // A thread starting there shows the wake among its start's steps.
    if (thread.owner?.brain !== "cloud" || thread.owner.reach !== "waking" || thread.cloud?.brain) return null;
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

/** Who a cloud turn signs in as, and where it runs. */
export interface CloudTurnWho {
  agent: string | null | undefined;
  claudeAccountId: string;
  model: string | null | undefined;
  /** On the cloud brain, which keeps its own Codex login. */
  brain: boolean;
  /** Simulated on this Mac, where the Mac's own sign-ins serve. */
  local: boolean;
}

function neededSignIn(rows: CloudSignIn[], who: CloudTurnWho): CloudSignIn | null {
  if (who.agent === "claude") return rows.find((row) => row.kind === "claude" && row.accountId === who.claudeAccountId) ?? null;
  if (who.agent === "codex") return rows.find((row) => row.kind === (who.brain ? "brain-codex" : "codex")) ?? null;
  const provider = who.agent === "opencode" ? openCodeProvider(who.model) : null;
  if (!provider || provider === OPENCODE_FREE_PROVIDER) return null;
  // A provider nobody has a key for yet is not among the rows; it takes a key typed in.
  return rows.find((row) => row.kind === "opencode" && row.provider === provider) ?? { kind: "opencode", provider, label: openCodeProviderName(provider), state: "missing", way: "key", error: null };
}

/** Who a thread's next cloud turn signs in as, when the send starts a process in its sandbox; null otherwise. */
export function cloudTurnOf(thread: Pick<ThreadSummary, "cloud" | "claudeAccountId" | "owner"> | null, choice: { agent: string; model: string } | null, busy: boolean): CloudTurnWho | null {
  // A send into a live process, or behind a running turn, starts nothing there, so it has nothing to sign in.
  if (!thread?.cloud || !choice || busy) return null;
  return {
    agent: choice.agent,
    claudeAccountId: thread.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT,
    model: choice.model,
    brain: thread.owner?.brain === "cloud",
    local: thread.cloud.provider === "local",
  };
}

/** The sign-in a cloud turn needs and the cloud lacks, or null when it has it or needs none. */
export function missingCloudSignIn(signIns: CloudSignIns, who: CloudTurnWho): CloudSignIn | null {
  const row = who.local ? null : neededSignIn(signIns.rows, who);
  return row && row.state !== "ready" ? row : null;
}
