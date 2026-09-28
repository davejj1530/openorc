const COMPOSER_MESSAGES = {
  stopping: "Stopping…",
  sending: "Sending…",
  generatingImage: "Generating image…",
  send: "Send (↵)",
  liveSend: "Send (↵). Reaches the active turn when supported; otherwise kept in order.",
  queueOrSteer: "Queue (↵), or say it now (⌘↵)",
  queue: "Queue for after this turn (↵)",
} as const;

export function composerActivity(input: { stopping: boolean; submitting: boolean; generatingImage: boolean }): string | null {
  if (input.stopping) return COMPOSER_MESSAGES.stopping;
  if (input.submitting) return COMPOSER_MESSAGES.sending;
  if (input.generatingImage) return COMPOSER_MESSAGES.generatingImage;
  return null;
}

export function composerSendHint(input: {
  disabledReason?: string | null;
  attachmentBlock?: string | null;
  liveByDefault?: boolean;
  queueing: boolean;
  steerable?: boolean;
  steerReason?: string | null;
}): string {
  if (input.disabledReason != null) return input.disabledReason;
  if (input.attachmentBlock != null) return input.attachmentBlock;
  if (input.liveByDefault) return COMPOSER_MESSAGES.liveSend;
  if (!input.queueing) return COMPOSER_MESSAGES.send;
  if (input.steerable) return COMPOSER_MESSAGES.queueOrSteer;
  if (input.steerReason) return `${COMPOSER_MESSAGES.queue}. ${input.steerReason}`;
  return COMPOSER_MESSAGES.queue;
}
