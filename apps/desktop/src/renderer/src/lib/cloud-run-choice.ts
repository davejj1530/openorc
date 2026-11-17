import { agentDefaultChoice, type ModelChoice } from "@openorc/client";
import { useRpc } from "./client";

/**
 * The model a start runs: the one chosen, or on OpenOrc Cloud, when the cloud doesn't run it, the cloud's default for the
 * same agent. The choice itself is kept, for a start on this Mac.
 */
export function useCloudRunChoice(choice: ModelChoice | null, onCloud: boolean): ModelChoice | null {
  const catalog = useRpc("cloudModels.catalog", {}, { enabled: onCloud, staleTime: 5 * 60_000 }).data?.models;
  if (!onCloud || !choice || !catalog || catalog.some((model) => model.agent === choice.agent && model.id === choice.model)) return choice;
  return agentDefaultChoice(catalog, choice.agent) ?? choice;
}
