import { z } from "zod";

export const MAX_TEAM_CONTEXT_BYTES = 64 * 1024;
const id = z.string().min(1);
const scope = { instanceId: id, executionId: id.nullable(), actorId: id };
function validScope(value: { executionId: string | null; actorId: string }): boolean {
  return value.executionId === null ? value.actorId === "lead" : value.actorId !== "lead";
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
    if (bytes > MAX_TEAM_CONTEXT_BYTES) break;
  }
  return bytes;
}

/** Lead context follows its instance; member context belongs to one assignment. */
export const TeamContextScope = z.object(scope).strict().refine(validScope, "Lead context uses instance scope; member context requires its execution.");
export type TeamContextScope = z.infer<typeof TeamContextScope>;
export const TeamContextSeed = z
  .string()
  .max(MAX_TEAM_CONTEXT_BYTES)
  .refine((value) => utf8Bytes(value) <= MAX_TEAM_CONTEXT_BYTES, "Context seed exceeds 64 KiB of UTF-8.");
export const TeamContextCheckpoint = z
  .object({
    id,
    ...scope,
    originExecutionId: id.nullable(),
    epoch: z.number().int().positive(),
    reason: z.enum(["fresh_retry", "compact"]),
    requestKey: id.max(200),
    seed: TeamContextSeed,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!validScope(value)) context.addIssue({ code: "custom", message: "Lead context uses instance scope; member context requires its execution." });
    if (value.reason === "fresh_retry" && !value.originExecutionId) context.addIssue({ code: "custom", message: "Fresh recovery requires its originating execution." });
    if (value.reason === "compact" && (value.executionId !== null || value.actorId !== "lead" || value.originExecutionId !== null))
      context.addIssue({ code: "custom", message: "Compaction requires instance-scoped lead context without an originating execution." });
    if (value.executionId && value.originExecutionId !== value.executionId) context.addIssue({ code: "custom", message: "Member context must originate in its own execution." });
  });
export type TeamContextCheckpoint = z.infer<typeof TeamContextCheckpoint>;
