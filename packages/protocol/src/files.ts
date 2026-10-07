import { z } from "zod";

export const FileScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), id: z.string() }),
  z.object({ kind: z.literal("task"), id: z.string() }),
  z.object({ kind: z.literal("project"), id: z.string(), workingDirectory: z.string().optional() }),
]);
