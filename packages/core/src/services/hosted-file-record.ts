import { z } from "zod";
import { TeamChatFile } from "@openorc/protocol";

const id = z.string().min(1);
const count = z.number().int().nonnegative();
/** Versioned disk data is private to this profile, separate from the account bearer store. */
export const HostedFileRecord = z.object({
  version: z.literal(1),
  id: z.uuid(),
  scope: z.object({
    accountId: id,
    apiOrigin: z.url(),
    spaceId: id,
    destination: z.discriminatedUnion("kind", [z.object({ kind: z.literal("hosted"), projectId: id, threadId: id.optional() }), z.object({ kind: z.literal("chat"), conversationId: id })]),
  }),
  draftKey: z.string().min(1).max(1000),
  name: z.string().min(1).max(1024),
  bytes: count,
  mime: z.string().max(256),
  selectedAt: count,
  imported: count,
  requestId: z.uuid(),
  phase: z.enum(["importing", "uploading", "ready", "failed", "cancelled"]),
  started: z.boolean().default(false),
  failure: z.object({ message: z.string(), retryable: z.boolean() }).nullable(),
  plan: z.object({ id, partBytes: z.number().int().positive(), parts: z.number().int().positive() }).nullable(),
  completedParts: z.array(z.number().int().positive()),
  file: TeamChatFile.nullable(),
});
export type HostedFileRecord = z.infer<typeof HostedFileRecord>;
export type HostedFileRef = Pick<HostedFileRecord, "scope" | "draftKey" | "id">;
export type NewHostedFile = Pick<HostedFileRecord, "scope" | "draftKey" | "id" | "name" | "bytes" | "mime">;
export const HOSTED_FILE_CHUNK_BYTES = 512 * 1024;
export const HOSTED_FILE_MAX_BYTES = 500 * 1024 * 1024;
export const FILE_NOT_IN_DRAFT = "That file isn't in this draft.";

export function sameFileDraft(a: Pick<HostedFileRef, "scope" | "draftKey">, b: Pick<HostedFileRef, "scope" | "draftKey">): boolean {
  return a.draftKey === b.draftKey && scopeKey(a.scope) === scopeKey(b.scope);
}

function scopeKey(scope: HostedFileRef["scope"]): string {
  const destination = scope.destination;
  const place = destination.kind === "chat" ? [destination.kind, destination.conversationId] : [destination.kind, destination.projectId, destination.threadId ?? null];
  return JSON.stringify([scope.apiOrigin, scope.accountId, scope.spaceId, ...place]);
}

export function newHostedFile(input: NewHostedFile): HostedFileRecord {
  const message = input.bytes === 0 ? "That file is empty." : null;
  const limit = input.bytes > HOSTED_FILE_MAX_BYTES ? "Keep files under 500 MB." : message;
  return HostedFileRecord.parse({
    ...input,
    version: 1,
    selectedAt: Date.now(),
    imported: 0,
    requestId: input.id,
    phase: limit ? "failed" : "importing",
    failure: limit ? { message: limit, retryable: false } : null,
    plan: null,
    completedParts: [],
    file: null,
  });
}
