import type { AgentKind, PermissionPreset, Run, RpcParams, RunMode, WorkspaceMode } from "@openorc/protocol";
import { conversationCanSteer } from "./conversation-presentation.js";
import type { ModelChoice } from "./model-picker-selection.js";
import type { ClientQueries } from "./query.js";

/** Where a send goes: a thread's conversation, or a task's, whose first run also says where it works. */
export type SubmitTarget = { kind: "thread"; threadId: string } | { kind: "task"; taskId: string; workspaceMode?: WorkspaceMode };

/** Everything a send is decided from. */
export interface SubmitInput {
  target: SubmitTarget;
  /** The conversation is busy: a turn, background work, an image, a compaction. */
  working: boolean;
  /** The newest run's process is still attached. */
  live: boolean;
  activeRun: Pick<Run, "id" | "agent" | "mode" | "permissionMode"> | undefined;
  /** Agents that ran in this conversation before, whose sessions a new process resumes. */
  agentsUsed: readonly AgentKind[];
  choice: ModelChoice | null;
  mode: RunMode;
  permission: PermissionPreset;
  permissionReady: boolean;
  compacting: boolean;
  /** The person asked for the running turn rather than the next one. */
  now: boolean;
  /** A new process that resumes nothing, whatever runs now: the way back from a lost session. */
  restart?: boolean;
}

/** What one send does: exactly one call to the core, or the reason it cannot go yet. */
export type SubmitPlan =
  /** Into the running turn (runs.send). */
  | { kind: "steer"; runId: string }
  /** After the running turn (threads.queue). */
  | { kind: "queue"; threadId: string }
  /** The next turn of the warm process (runs.send). */
  | { kind: "continue"; runId: string }
  /** A new process (runs.start) on the chosen model, resuming the agent's last session here when it has one. */
  | { kind: "start"; choice: ModelChoice; resume: boolean }
  | { kind: "blocked"; reason: string };

/** How the conversation's live process fits what the person has chosen. */
export function processFit(input: Pick<SubmitInput, "live" | "activeRun" | "choice" | "mode" | "permission" | "compacting">) {
  const { live, activeRun, choice } = input;
  const sameAgent = Boolean(activeRun && choice && activeRun.agent === choice.agent);
  // Mode and permissions are fixed when a process starts, so a change needs a new one; the model, effort and Fast
  // change on the live session when the next message is sent.
  const settingsPending = Boolean(live && activeRun && (activeRun.mode !== input.mode || activeRun.permissionMode !== input.permission));
  const canSteer = conversationCanSteer({ live, sameAgent, agent: activeRun?.agent, compacting: input.compacting, settingsPending });
  return { sameAgent, settingsPending, canSteer };
}

const NO_MODEL: SubmitPlan = { kind: "blocked", reason: "Choose a model first." };
const PERMISSIONS_LOADING: SubmitPlan = { kind: "blocked", reason: "Wait for your saved permissions to load." };

function restartPlan(input: SubmitInput): SubmitPlan {
  if (!input.permissionReady) return PERMISSIONS_LOADING;
  return input.choice ? { kind: "start", choice: input.choice, resume: false } : NO_MODEL;
}

/**
 * The send tree. A busy thread takes the message into the turn when asked and able, and otherwise queues it; a warm
 * process with the same agent and settings takes the next turn; anything else starts a process.
 */
export function planSubmit(input: SubmitInput): SubmitPlan {
  if (input.restart) return restartPlan(input);
  const { activeRun, choice, target } = input;
  if (!choice) return NO_MODEL;
  const { sameAgent, settingsPending, canSteer } = processFit(input);
  if (target.kind === "thread" && input.working) return input.now && canSteer && activeRun ? { kind: "steer", runId: activeRun.id } : { kind: "queue", threadId: target.threadId };
  if (input.live && sameAgent && activeRun && !settingsPending) return { kind: "continue", runId: activeRun.id };
  if (!input.permissionReady) return PERMISSIONS_LOADING;
  return { kind: "start", choice, resume: input.agentsUsed.includes(choice.agent) };
}

/** What a send says: what was written, or a word for an image or an empty start. */
export function messageBody(text: string, attachments: readonly string[]): string {
  if (text) return text;
  return attachments.length ? "See the attached image." : "Start working on this task.";
}

export interface ComposerActionsInput {
  /** A turn is running, so a send waits for it unless it goes in now. */
  queueing: boolean;
  /** A send goes into the running turn unless the person queues it. */
  liveByDefault: boolean;
  /** The running turn can take a message now. */
  steerable: boolean;
  /** Something is running that Stop would end. */
  canStop: boolean;
  /** The draft has text, attachments, or files still uploading. */
  hasDraft: boolean;
}

function primaryAction(stopping: boolean, waits: boolean): "send" | "queue" | "stop" {
  if (stopping) return "stop";
  return waits ? "queue" : "send";
}

/**
 * The composer's controls, so the button and what it does never disagree. With nothing to send while something
 * runs, the main button stops it; otherwise it sends, or queues when a running turn would make the message wait.
 */
export function composerActions(input: ComposerActionsInput) {
  const stopping = input.canStop && !input.hasDraft;
  const waits = input.queueing && !input.liveByDefault;
  return {
    primary: primaryAction(stopping, waits),
    /** Into the running turn, beside a main button that queues. */
    sendNow: !stopping && waits && input.steerable,
    /** For after the running turn, beside a main button that sends into it. */
    queue: !stopping && input.queueing && input.liveByDefault,
    stop: input.canStop && !stopping,
    /** What the main button and Enter ask for: the running turn, or the next one. */
    sendsNow: input.liveByDefault && input.queueing,
  } as const;
}

/** A send as the person made it, decided once every setting they chose is saved. */
export interface SubmitRequest extends SubmitInput {
  /** Resolves once every setting chosen so far is saved, so a message never meets a process with stale ones. */
  waitForSave(): Promise<unknown>;
}

function startParams(request: SubmitRequest, plan: Extract<SubmitPlan, { kind: "start" }>, prompt: string, attachments: string[]): RpcParams<"runs.start"> {
  const { kind: _kind, ...where } = request.target;
  const { choice } = plan;
  return {
    ...where,
    agent: choice.agent,
    model: choice.model,
    effort: choice.effort ?? undefined,
    fastMode: Boolean(choice.fastMode),
    attachments,
    mode: request.mode,
    permissionMode: request.permission,
    prompt,
    resume: plan.resume,
  };
}

/** The three calls a send can make. */
export interface SubmitCalls {
  start: { mutateAsync(params: RpcParams<"runs.start">): Promise<unknown> };
  send: { mutateAsync(params: RpcParams<"runs.send">): Promise<unknown> };
  queue: { mutateAsync(params: RpcParams<"threads.queue">): Promise<unknown> };
}

/** Sends one message: plans it once every chosen setting is saved, then makes the plan's one call. */
export async function sendMessage(calls: SubmitCalls, randomId: () => string, request: SubmitRequest, message: { text: string; attachments: string[] }): Promise<void> {
  await request.waitForSave();
  const plan = planSubmit(request);
  const text = messageBody(message.text, message.attachments);
  const { attachments } = message;
  switch (plan.kind) {
    case "blocked":
      throw new Error(plan.reason);
    case "steer":
    case "continue":
      await calls.send.mutateAsync({ runId: plan.runId, text, attachments });
      return;
    case "queue":
      await calls.queue.mutateAsync({ id: plan.threadId, text, attachments, requestKey: randomId() });
      return;
    case "start":
      await calls.start.mutateAsync(startParams(request, plan, text, attachments));
  }
}

/** The one way to send. `pending` and `error` cover every call a send can make. */
export function useSubmitWith(useRpcMutation: ClientQueries["useRpcMutation"], randomId: () => string) {
  const calls = { start: useRpcMutation("runs.start"), send: useRpcMutation("runs.send"), queue: useRpcMutation("threads.queue") };
  return {
    submit: (request: SubmitRequest, message: { text: string; attachments: string[] }) => sendMessage(calls, randomId, request, message),
    pending: calls.start.isPending || calls.send.isPending || calls.queue.isPending,
    error: calls.start.error ?? calls.send.error ?? calls.queue.error,
  };
}
