import { z } from "zod";
import { HarnessId } from "./harness.js";

/** Providers with executable adapters. */
export const ExecutableAgent = HarnessId;
export type ExecutableAgent = HarnessId;

export const ModelExecutionSettings = z
  .object({
    agent: ExecutableAgent,
    model: z.string().trim().min(1).max(200),
    effort: z.string().trim().min(1).max(40).nullable(),
    fastMode: z.boolean(),
  })
  .strict();
export type ModelExecutionSettings = z.infer<typeof ModelExecutionSettings>;

/** A launch names either model settings or an Orcling. */
export const ExecutionTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model"), settings: ModelExecutionSettings }).strict(),
  z.object({ kind: z.literal("orcling"), orclingId: z.string().min(1) }).strict(),
]);
export type ExecutionTarget = z.infer<typeof ExecutionTarget>;

export function formatModelEffortLabel(model: string, effort: string | null | undefined): string {
  const modelLabel = model.trim();
  const effortLabel = effort?.trim();
  return effortLabel ? `${modelLabel} - ${effortLabel}` : modelLabel;
}
