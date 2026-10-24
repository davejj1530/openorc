import { harnessCatalog, isHarnessId } from "@openorc/protocol";

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

export function conversationSendDisabledReason(input: { permissionReady: boolean; historyLoading: boolean; historyFailed: boolean; hasModel: boolean }): string | null {
  if (!input.permissionReady) return CONVERSATION_REASONS.loadingPermissions;
  if (input.historyLoading) return CONVERSATION_REASONS.loadingHistory;
  if (input.historyFailed) return CONVERSATION_REASONS.failedHistory;
  if (!input.hasModel) return CONVERSATION_REASONS.missingModel;
  return null;
}
