import { z } from "zod";
import { TeamChatFile } from "./team-chat.js";

export const HOSTED_FILE_CHUNK_BYTES = 512 * 1024;
export const HOSTED_FILE_MAX_BYTES = 500 * 1024 * 1024;
const id = z.string().min(1);
const count = z.number().int().nonnegative();
export const HostedFileScope = z
  .object({
    accountId: id,
    apiOrigin: z.url(),
    spaceId: id,
    destination: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("hosted"), projectId: id, threadId: id.optional() }).strict(),
      z.object({ kind: z.literal("chat"), conversationId: id }).strict(),
    ]),
  })
  .strict();
export type HostedFileScope = z.infer<typeof HostedFileScope>;
const draft = z.object({ scope: HostedFileScope, draftKey: z.string().min(1).max(1000) }).strict();
const ref = draft.extend({ id: z.uuid() });
const source = ref.extend({ name: z.string().min(1).max(1024), bytes: count, mime: z.string().max(256) });
export const HostedDraftFile = z.object({
  id: z.uuid(),
  name: z.string(),
  bytes: count,
  mime: z.string(),
  selectedAt: count,
  imported: count,
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("importing") }),
    z.object({ kind: z.literal("uploading"), sent: count }),
    z.object({ kind: z.literal("ready"), file: TeamChatFile }),
    z.object({ kind: z.literal("failed"), message: z.string(), retryable: z.boolean() }),
  ]),
});
export type HostedDraftFile = z.infer<typeof HostedDraftFile>;
export type HostedFileDraft = z.infer<typeof draft>;
export type HostedFileRef = z.infer<typeof ref>;
const asset = z.object({ scope: HostedFileScope, file: z.object({ id, name: z.string() }).strict() }).strict();

/** Window-only file transfer. Account credentials and arbitrary authenticated URLs never cross this boundary. */
export const hostedFilesRpcParams = {
  "hostedFiles.capture": z.object({ scope: HostedFileScope }).strict(),
  "hostedFiles.state": draft,
  "hostedFiles.begin": source,
  "hostedFiles.append": ref.extend({
    offset: count,
    data: z
      .string()
      .min(1)
      .max(4 * Math.ceil(HOSTED_FILE_CHUNK_BYTES / 3))
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0, "This file chunk couldn't be read.")
      .refine((data) => (data.length / 4) * 3 - (data.match(/=+$/)?.[0].length ?? 0) <= HOSTED_FILE_CHUNK_BYTES, "This file chunk is too large."),
  }),
  "hostedFiles.finish": ref,
  "hostedFiles.retry": ref,
  "hostedFiles.remove": ref,
  "hostedFiles.accepted": ref,
  "hostedFiles.preview": ref,
  "hostedFiles.thumbnail": asset,
  "hostedFiles.download": asset,
};
export interface HostedFilesRpcResults {
  "hostedFiles.capture": HostedFileScope;
  "hostedFiles.state": { files: HostedDraftFile[] };
  "hostedFiles.begin": HostedDraftFile;
  "hostedFiles.append": { imported: number };
  "hostedFiles.finish": Record<string, never>;
  "hostedFiles.retry": Record<string, never>;
  "hostedFiles.remove": Record<string, never>;
  "hostedFiles.accepted": Record<string, never>;
  "hostedFiles.preview": { contentType: string; data: string } | null;
  "hostedFiles.thumbnail": { contentType: "image/webp"; data: string };
  "hostedFiles.download": { saved: boolean };
}
