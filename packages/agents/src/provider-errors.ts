import type { ActivityRecovery, AgentEvent, HarnessId } from "@openorc/protocol";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Only provider failures enter here, never assistant prose or a tool's output. A 429 alone is not a usage limit. */
function recoveryFor(provider: HarnessId, error: unknown): ActivityRecovery | undefined {
  const message = messageOf(error);
  const authRequired = error && typeof error === "object" && "code" in error && error.code === -32000;
  if (authRequired || /\b(?:authentication required|not (?:logged|signed) in|(?:login|access token|refresh token) (?:has )?expired|please (?:sign|log) in)\b/i.test(message))
    return { kind: "sign_in", provider };
  if (
    /\b(?:usage limit (?:has been )?(?:reached|exceeded)|quota (?:has been )?(?:exceeded|exhausted)|insufficient[_ ]quota|insufficient credits|credit balance (?:is )?(?:too low|exhausted))\b/i.test(
      message,
    )
  )
    return { kind: "usage", provider };
  return undefined;
}

export function providerErrorActivity(runId: string, provider: HarnessId, activityId: string, error: unknown, text = messageOf(error)): Extract<AgentEvent, { type: "activity.updated" }> {
  const recovery = recoveryFor(provider, error);
  return { type: "activity.updated", runId, ts: Date.now(), activityId, label: "Provider error", status: "error", text, ...(recovery ? { recovery } : {}) };
}

/** Startup failures also need a recovery action, even when no turn started. */
export function emitProviderFailure(emit: (event: AgentEvent) => void, runId: string, provider: HarnessId, error: unknown): void {
  const activity = providerErrorActivity(runId, provider, `error-${runId}`, error);
  if (activity.recovery) emit(activity);
  emit({ type: "error", runId, ts: activity.ts, message: activity.text!, fatal: true });
}
