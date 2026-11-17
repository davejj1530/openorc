import { agentDefaultChoice, type ModelChoice } from "@openorc/client";
import type { ModelOption } from "@openorc/protocol";
import { useRpc } from "./client";

/** The models OpenOrc Cloud runs, for a start there: none until known, nor where its server keeps no catalog. */
export function useCloudModels(onCloud: boolean): ModelOption[] | undefined {
  return useRpc("cloudModels.catalog", {}, { enabled: onCloud, staleTime: 5 * 60_000 }).data?.models;
}

/**
 * The model a start runs: the one chosen, or on OpenOrc Cloud (`cloud`, its catalog), when the cloud doesn't run it, the
 * cloud's default for the same agent. The choice itself is kept, for a start on this Mac.
 */
export function cloudRunChoice(choice: ModelChoice | null, cloud: readonly ModelOption[] | undefined): ModelChoice | null {
  if (!choice || !cloud || cloud.some((model) => model.agent === choice.agent && model.id === choice.model)) return choice;
  return agentDefaultChoice([...cloud], choice.agent) ?? choice;
}
