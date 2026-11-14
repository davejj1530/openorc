import { defaultHarnessId, harnessShortName, type AgentKind, type ThreadSummary } from "@openorc/protocol";
import { rowStarter } from "./thread-row.js";
import { threadTogether, threadWriteBlock } from "./thread-collaboration.js";

const COMPOSER_MESSAGES = {
  stopping: "Stopping…",
  sending: "Sending…",
  generatingImage: "Generating image…",
} as const;

/** A thread's composer says who reads the message, in every state; what Enter does is the send's own word. */
export function composerPlaceholder(agent: AgentKind | undefined, thread?: Pick<ThreadSummary, "owner"> | null): string {
  const starter = thread ? rowStarter(thread) : null;
  // A teammate's thread reads as theirs while this person cannot run its agent; once the server lets them, as any other.
  if (starter && (!threadTogether(thread) || threadWriteBlock(thread))) return `${starter.first}'s thread`;
  return `Message ${harnessShortName(agent ?? defaultHarnessId)}…`;
}

/** What the composer is doing with the last send or the running turn, in a word or two; null when nothing. */
export function composerActivity(input: { stopping: boolean; submitting: boolean; generatingImage: boolean }): string | null {
  if (input.stopping) return COMPOSER_MESSAGES.stopping;
  if (input.submitting) return COMPOSER_MESSAGES.sending;
  if (input.generatingImage) return COMPOSER_MESSAGES.generatingImage;
  return null;
}

/** Why a send cannot go, when it cannot: said on demand by the dimmed send. */
export function composerSendBlock(input: { disabledReason?: string | null; attachmentBlock?: string | null }): string | null {
  return input.disabledReason ?? input.attachmentBlock ?? null;
}

/**
 * What the pile of queued messages does next: they send when the agent finishes, unless every one of them failed to
 * send and waits to be retried or removed.
 */
export function queueHint(messages: readonly { interrupted?: boolean | undefined; error?: string | null | undefined }[], agentName: string | undefined): string {
  if (messages.length && messages.every((message) => message.interrupted || message.error)) return "Didn't send";
  return agentName ? `Sends when ${agentName} finishes` : "Runs after this turn";
}
