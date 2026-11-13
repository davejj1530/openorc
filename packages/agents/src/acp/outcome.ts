import type { PromptResponse, StopReason } from "@agentclientprotocol/sdk";
import type { RunStatus } from "@openorc/protocol";
import type { AcpProfile } from "./profile.js";

const statuses = new Map<string, RunStatus>([
  ["end_turn", "success"],
  ["cancelled", "cancelled"],
  ["max_tokens", "error"],
  ["max_turn_requests", "max_turns"],
  ["refusal", "error"],
] satisfies [StopReason, RunStatus][]);

/** Preserve native failures and reject unknown terminal states instead of emitting an invalid success event. */
export function promptOutcome(profile: AcpProfile, response: PromptResponse | null, error: unknown, text: string, planShown: boolean | undefined, model: string | undefined) {
  const reason = response?.stopReason ?? "end_turn";
  const native = profile.promptOutcome?.(reason, text);
  let status = native?.status ?? statuses.get(reason);
  let failure = error ?? native?.error;
  if (!status) {
    status = "error";
    failure ??= new Error(`${profile.name} returned an unrecognized stop reason: ${reason}. Check for OpenOrc and agent updates, then retry.`);
  }
  if (failure) status = "error";
  else if (planShown && reason === "cancelled") status = "success";
  return { status, error: failure, message: failure ? promptFailure(failure, model, profile.name) : null };
}

function promptFailure(error: unknown, model: string | undefined, agentName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/model unavailable/i.test(message)) {
    const name = model ?? message.replace(/^.*model unavailable:\s*/i, "");
    return `${agentName} reports ${name} is unavailable. Check the model ID, provider configuration and account access, or choose another model. Provider detail: ${message}`;
  }
  return message;
}
