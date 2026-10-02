import type { HarnessId } from "./harness.js";

export interface AgentUpdate {
  id: HarnessId;
  installedVersion: string | null;
  latestVersion: string | null;
  /** `broken`: installed but fails to start, so a reinstall is the remedy. */
  status: "not_installed" | "unchecked" | "current" | "available" | "broken" | "checking" | "updating" | "reinstalling" | "error";
  method: string;
  /** OpenOrc can run the update, or the reinstall for a broken installation, itself. */
  canUpdate: boolean;
  message: string | null;
  checkedAt: number | null;
}

export interface AgentUpdates {
  agents: AgentUpdate[];
  checking: boolean;
  updating: boolean;
  automatic: boolean;
  dismissed: string | null;
}

/** A dismissal belongs to these releases, not to every future update. */
export function agentUpdateNoticeKey(agents: readonly AgentUpdate[]): string {
  return agents
    .filter((row) => row.status === "available")
    .map((row) => `${row.id}:${row.latestVersion}`)
    .sort()
    .join("|");
}
