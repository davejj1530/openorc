import { defaultHarnessId, harnessCatalog, harnessShortName, isHarnessId, type AgentKind, type Run, type ThreadSummary } from "@openorc/protocol";
import { isImageGeneration } from "./image-activity.js";
import { sendsBlocked } from "./hosted-send.js";
import type { RunTranscript } from "./transcript.js";

const CONVERSATION_REASONS = {
  compacting: "Wait for the conversation to finish compacting.",
  savingSettings: "Saving the mode for the next turn.",
  differentProvider: "This turn belongs to the other provider. It will be queued.",
  noLiveInput: "This agent reads new messages after its turn. It will be queued.",
  betweenTurns: "The agent is between turns. It will be queued.",
  loadingPermissions: "Loading saved permissions…",
  loadingHistory: "Loading agent history",
  failedHistory: "Could not load agent history",
  missingModel: "Choose a model",
} as const;

/** Whether the harness can take a message during a running turn; otherwise the message waits in the queue. */
export function acceptsLiveInput(agent: string | undefined): boolean {
  return isHarnessId(agent) && harnessCatalog[agent].liveInput;
}

/** Whether a message can go into the running turn now rather than wait for the next one. */
export function conversationCanSteer(input: { live: boolean; sameAgent: boolean; agent: string | undefined; compacting: boolean; settingsPending: boolean }): boolean {
  return input.live && input.sameAgent && acceptsLiveInput(input.agent) && !input.compacting && !input.settingsPending;
}

export function conversationSteerReason(input: { canSteer: boolean; compacting: boolean; settingsPending: boolean; sameAgent: boolean; agent: string | undefined }): string | null {
  if (input.canSteer) return null;
  if (input.compacting) return CONVERSATION_REASONS.compacting;
  if (input.settingsPending) return CONVERSATION_REASONS.savingSettings;
  if (!input.sameAgent) return CONVERSATION_REASONS.differentProvider;
  if (!acceptsLiveInput(input.agent)) return CONVERSATION_REASONS.noLiveInput;
  return CONVERSATION_REASONS.betweenTurns;
}

/** Why the composer cannot send now, from the thread's access and location through its saved settings. */
export function conversationSendDisabledReason(input: {
  permissionReady: boolean;
  historyLoading: boolean;
  historyFailed: boolean;
  hasModel: boolean;
  thread?: Pick<ThreadSummary, "owner"> | null | undefined;
}): string | null {
  const blocked = sendsBlocked(input.thread ?? null);
  if (blocked) return blocked;
  if (!input.permissionReady) return CONVERSATION_REASONS.loadingPermissions;
  if (input.historyLoading) return CONVERSATION_REASONS.loadingHistory;
  if (input.historyFailed) return CONVERSATION_REASONS.failedHistory;
  if (!input.hasModel) return CONVERSATION_REASONS.missingModel;
  return null;
}

/**
 * Whether a conversation's newest process is attached, and whether the conversation is busy: a turn, background work,
 * an image being made, a compaction. A thread says for itself; a task's conversation is busy while a reply streams.
 * A run that ended is not attached even when its transcript never heard the end, as a cloud run's last frames are not
 * relayed once no window has read it for a while. A thread whose place can't be reached has nothing attached: what it
 * last said stands as it was.
 *
 * A thread waiting on the person is busy only while its turn is open, as on this Mac, where the agent waits mid-turn.
 * An ask that outlived its turn (OpenOrc Cloud parks one) waits on nothing running, so a message starts a turn.
 */
export function conversationActivity(input: { thread: Pick<ThreadSummary, "activity" | "owner"> | null; activeRun: Run | undefined; liveTranscript: RunTranscript | undefined; compacting: boolean }) {
  const { liveTranscript, activeRun } = input;
  const reachable = input.thread?.owner?.reach !== "offline";
  const live = reachable && Boolean(activeRun && activeRun.endedAt === null && liveTranscript?.live);
  const generatingImage = live && Boolean(liveTranscript?.blocks.some((b) => isImageGeneration(b) && b.kind === "activity" && b.status === "running"));
  const replying = live && Boolean(liveTranscript?.blocks.some((b) => b.kind === "message" && b.role === "assistant" && b.streaming));
  const busy = (activity: ThreadSummary["activity"]) => activity === "running" || (activity === "waiting" && activeRun?.endedAt === null);
  const working = generatingImage || input.compacting || (input.thread ? busy(input.thread.activity) : replying);
  return { live, working, generatingImage };
}

/** A transcript as the conversation shows it: a thread out of reach shows its last turn as heard, not as running now. */
export function heardTranscript<T extends Pick<RunTranscript, "live" | "turnOpen">>(run: T, thread: Pick<ThreadSummary, "owner"> | null): T {
  return thread?.owner?.reach === "offline" && (run.live || run.turnOpen) ? { ...run, live: false, turnOpen: false } : run;
}

/**
 * What the empty prompt invites: a message to the agent, one for the running turn, or one for after it. While the
 * agent waits on an answer mid-turn, a queued message goes once the person answered and the turn ended.
 */
export function conversationPlaceholder({
  firstTaskRun,
  working,
  canSteer,
  waiting = false,
  agent,
}: {
  firstTaskRun: boolean;
  working: boolean;
  canSteer: boolean;
  waiting?: boolean;
  agent: AgentKind | undefined;
}): string {
  if (firstTaskRun) return "Add direction, or send to start this task…";
  if (working && canSteer) return "Say it during this turn…";
  if (working) return waiting ? "Queue a message for after your answer…" : "Queue a message for when it finishes…";
  return `Message ${harnessShortName(agent ?? defaultHarnessId)}…`;
}
