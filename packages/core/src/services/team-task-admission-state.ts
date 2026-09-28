import type { TeamActorRecord, TeamExecutionRecord, TeamMailboxMessage, TeamTaskAdmissionRoute } from "@openorc/protocol";

interface AdmissionOutcomeInput {
  completed: boolean;
  route: Pick<TeamTaskAdmissionRoute, "role" | "messageId"> | undefined;
  actor: Pick<TeamActorRecord, "id" | "state"> | undefined;
  executionState: TeamExecutionRecord["state"] | undefined;
  messageState: TeamMailboxMessage["state"] | undefined;
}

/** Shared by display and admission checks; never consults retry availability. */
export function terminalAdmissionState({ completed, route, actor, executionState, messageState }: AdmissionOutcomeInput): "completed" | "stopped" | null {
  if (completed || (route?.role === "assignee" && actor?.id !== "lead" && actor?.state === "completed" && (route.messageId === null || messageState === "delivered"))) return "completed";
  if (executionState === "stopped" || actor?.state === "cancelled" || messageState === "cancelled") return "stopped";
  return null;
}
