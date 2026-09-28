import { effortLabel, formatModelEffortLabel, type ModelExecutionSettings, type ModelOption } from "@openorc/protocol";
import { useRpc } from "./query";

type ModelChoice = Pick<ModelExecutionSettings, "agent" | "model" | "effort">;

/** The model's display name; the raw model id when the catalogue does not know it. */
export function modelLabel(settings: Omit<ModelChoice, "effort">, models: readonly ModelOption[] | undefined): string {
  return models?.find((candidate) => candidate.agent === settings.agent && candidate.id === settings.model)?.label ?? settings.model;
}

/**
 * "GPT-6 Astra - High": the model's display name and the effort it ran with,
 * or the model alone when the run recorded no effort.
 */
export function modelEffortLabel(settings: ModelChoice, models: readonly ModelOption[] | undefined): string {
  return formatModelEffortLabel(modelLabel(settings, models), settings.effort ? effortLabel(settings.effort) : null);
}

/** The label above, resolved against the live model catalogue; null when there are no settings to describe. */
export function useModelEffortLabel(settings: ModelExecutionSettings | null | undefined): string | null {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  return settings ? modelEffortLabel(settings, models.data) : null;
}
