import { z } from "zod";
import type { FileReply } from "./stand-in-file-data.js";

const file = { name: z.string().min(1).max(1024), bytes: z.number().int().nonnegative(), requestId: z.uuid().optional() };
export const startFileInput = z.union([z.object({ ...file, conversationId: z.string().min(1) }), z.object({ ...file, to: z.literal("hosted") })]);
export const signFilePartsInput = z.object({ parts: z.array(z.number().int().min(1).max(10_000)).min(1).max(16) });

/** Decorated body schemas use the server's array envelope, including the issue path. */
export const fileInputRefusal = (error: z.ZodError): FileReply => ({
  status: 400,
  body: { message: error.issues.map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`), error: "Bad Request", statusCode: 400 },
});
