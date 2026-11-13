/** Why closing the core now would cut something short. Each table below is a Record over it, so a new reason must be handled in both. */
export type BusyReason = "agent-updates" | "memory" | "schedules" | "background-commands" | "agents" | "queued-messages" | "cloud-sandboxes" | "text-generation" | "claude-sign-in" | "phones";

/** The state each reason is read from, kept by the service that owns it, as the core holds them. Nothing here is copied or stored. */
export interface ActivitySources {
  runs: { readonly busy: boolean; readonly backgroundCommandsRunning: boolean; prepareForUpdate(): boolean };
  threads: { readonly deliveringQueued: boolean };
  cloud: { readonly busy: boolean };
  memory: { readonly hasPendingWork: boolean };
  textGeneration: { readonly hasPendingWork: boolean };
  schedules: { readonly hasPendingWork: boolean; stopAccepting(): void };
  claudeAccounts: { readonly hasPendingWork: boolean };
  agentUpdates: { get(): { updating: boolean } };
  remote: { readonly busy: boolean };
}

/** Checked in this order; the first that holds is the reason given. */
const CHECKS: { readonly [R in BusyReason]: (sources: ActivitySources) => boolean } = {
  "agent-updates": (s) => s.agentUpdates.get().updating,
  memory: (s) => s.memory.hasPendingWork,
  schedules: (s) => s.schedules.hasPendingWork,
  "background-commands": (s) => s.runs.backgroundCommandsRunning,
  agents: (s) => s.runs.busy,
  "queued-messages": (s) => s.threads.deliveringQueued,
  "cloud-sandboxes": (s) => s.cloud.busy,
  "text-generation": (s) => s.textGeneration.hasPendingWork,
  "claude-sign-in": (s) => s.claudeAccounts.hasPendingWork,
  phones: (s) => s.remote.busy,
};

/**
 * What a refused update says for each reason. Null lets the update go ahead anyway, as it always has: a phone
 * reconnects, a message caught mid-delivery stays in its queue to retry, cloud work carries on in its VM, and a title
 * or a sign-in is tried again.
 */
const UPDATE_WORDS: { readonly [R in BusyReason]: string | null } = {
  "agent-updates": "Wait for agent updates to finish before restarting.",
  memory: "Wait for memory processing to finish before restarting to update.",
  schedules: "A schedule is starting a thread. Try again when it has started.",
  "background-commands": "Stop the background commands running in your conversations before restarting to update.",
  agents: "Wait for agent work, approvals, and context maintenance to finish before restarting to update.",
  "queued-messages": null,
  "cloud-sandboxes": null,
  "text-generation": null,
  "claude-sign-in": null,
  phones: null,
};

/**
 * What a refused switch of where the app runs says. A switch leaves this place closed until someone switches back, so
 * what an update lets through because the same core returns at once is waited for here: a message caught mid-delivery,
 * a title being written, a sign-in. Cloud work still carries on in its VM, and a phone reconnects on the way back.
 */
const SWITCH_WORDS: { readonly [R in BusyReason]: string | null } = {
  "agent-updates": "Wait for agent updates to finish first, then switch.",
  memory: "Wait for memory processing to finish first, then switch.",
  schedules: UPDATE_WORDS.schedules,
  "background-commands": "Stop the background commands running in your conversations first, then switch.",
  agents: "Wait for agent work, approvals, and context maintenance to finish first, then switch.",
  "queued-messages": "A queued message is being delivered. Try again in a moment.",
  "cloud-sandboxes": null,
  "text-generation": "OpenOrc is still writing text in the background, such as a title. Try again in a moment.",
  "claude-sign-in": "Finish or cancel the Claude sign-in first, then switch.",
  phones: null,
};

const REASONS = Object.keys(CHECKS) as BusyReason[];

/** Why closing the core now would cut something short, or null when nothing would. Read when asked, never stored. */
export function busyReason(sources: ActivitySources): BusyReason | null {
  return REASONS.find((reason) => CHECKS[reason](sources)) ?? null;
}

/** Refuses with the first blocking reason's words, or fences new turns and schedules. Never yields between the two. */
function fence(sources: ActivitySources, words: { readonly [R in BusyReason]: string | null }): string | null {
  const blocking = REASONS.find((reason) => words[reason] !== null && CHECKS[reason](sources));
  if (blocking) return words[blocking];
  if (!sources.runs.prepareForUpdate()) return words.agents;
  sources.schedules.stopAccepting();
  return null;
}

/**
 * Refuses a restart for an update with the first blocking reason's words, or fences new turns and schedules for it.
 * Runs without yielding, so nothing starts between the checks and the fence.
 */
export function fenceForUpdate(sources: ActivitySources): string | null {
  return fence(sources, UPDATE_WORDS);
}

/** The same for a switch of where the app runs, which waits for more: see SWITCH_WORDS. */
export function fenceForSwitch(sources: ActivitySources): string | null {
  return fence(sources, SWITCH_WORDS);
}
