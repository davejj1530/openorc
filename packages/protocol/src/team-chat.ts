import { z } from "zod";
import { SpaceId } from "./spaces.js";
import { teamChatChannelRpcParams, type TeamChatChannelRpcResults } from "./team-chat-channels.js";
import { teamChatReadRpcParams, type TeamChatReadRpcResults } from "./team-chat-read.js";

const id = z.string().min(1).max(200);
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TeamChatPerson = z.object({ id, name: z.string(), image: z.string().nullable() });
export type TeamChatPerson = z.infer<typeof TeamChatPerson>;
export const TeamChatFeature = z.enum(["base", "channels", "groups", "files", "presence", "unread", "replies", "pins", "search", "orcling"]);
export type TeamChatFeature = z.infer<typeof TeamChatFeature>;
export const TeamChatReaction = z.enum(["👍", "❤️", "😄", "🎉", "👀", "✅"]);
export type TeamChatReaction = z.infer<typeof TeamChatReaction>;
export const TeamChatRead = z.object({ seenSeq: seq, seenThroughMessageId: id.nullable(), unread: seq, hasMention: z.boolean() });
export type TeamChatRead = z.infer<typeof TeamChatRead>;

export const TeamConversation = z.object({
  id,
  kind: z.enum(["channel", "dm"]),
  name: z.string().nullable(),
  topic: z.string().nullable(),
  private: z.boolean(),
  members: z.array(TeamChatPerson),
  joined: z.boolean(),
  lastMessageAt: z.iso.datetime().nullable(),
  canAddMembers: z.boolean(),
  canRemoveMembers: z.boolean(),
  createdAt: z.iso.datetime(),
  participants: z.array(z.object({ person: TeamChatPerson, inOrganization: z.boolean() })).nullable(),
  lastMessageSeq: seq,
  read: TeamChatRead.nullable(),
});
export type TeamConversation = z.infer<typeof TeamConversation>;

/** Unknown feature names never enable a control. Legacy unread is deliberately not projected. */
export const TeamChatState = z.object({
  features: z.array(z.string()).transform((features) =>
    features.flatMap((feature) => {
      const parsed = TeamChatFeature.safeParse(feature);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  people: z.array(TeamChatPerson),
  conversations: z.array(TeamConversation),
});
export type TeamChatState = z.infer<typeof TeamChatState>;

export const TeamChatFile = z.object({
  id,
  name: z.string(),
  bytes: seq,
  contentType: z.string(),
  kind: z.enum(["image", "video", "audio", "file"]),
});
export type TeamChatFile = z.infer<typeof TeamChatFile>;

/** The message a reply answers, as the reply shows it: who wrote it and its first words, empty when it is only files. */
export const TeamChatAnswered = z.object({ id, seq, person: TeamChatPerson.nullable(), excerpt: z.string(), files: seq });
export type TeamChatAnswered = z.infer<typeof TeamChatAnswered>;

/** Human messages have their own projection, independent of work runs and agent events. */
export const TeamMessage = z.object({
  id,
  channelId: id,
  seq: seq.refine((value) => value > 0),
  actor: z.object({ kind: z.literal("person"), person: TeamChatPerson.nullable() }),
  body: z.string(),
  files: z.array(TeamChatFile),
  reactions: z.array(z.object({ emoji: z.string(), userIds: z.array(id) })),
  /** A server without replies sends none. */
  replyTo: TeamChatAnswered.nullable().default(null),
  /** Who pinned it for everyone in the conversation, and when; a server without pins sends none. */
  pinned: z.object({ by: TeamChatPerson.nullable(), at: z.iso.datetime() }).nullable().default(null),
  call: z.null(),
  createdAt: z.iso.datetime(),
});
export type TeamMessage = z.infer<typeof TeamMessage>;
export const TeamChatTimeline = z.object({ messages: z.array(TeamMessage).max(60), older: z.boolean(), newer: z.boolean(), headSeq: seq, read: TeamChatRead.nullable() });
export type TeamChatTimeline = z.infer<typeof TeamChatTimeline>;
/** A conversation's pinned messages, the latest pinned first. */
export const TeamChatPins = z.object({ pins: z.array(z.object({ message: TeamMessage, pinnedBy: TeamChatPerson.nullable(), pinnedAt: z.iso.datetime() })) });
export type TeamChatPins = z.infer<typeof TeamChatPins>;
/** A message of a conversation's line that matched a search, with its words around what matched, marked by offsets. */
export const TeamChatSearchHit = z.object({
  id,
  channelId: id,
  seq: seq.refine((value) => value > 0),
  person: TeamChatPerson.nullable(),
  snippet: z.object({ text: z.string(), marks: z.array(z.tuple([seq, seq])) }),
  files: z.array(z.object({ name: z.string(), kind: z.string() })),
  createdAt: z.iso.datetime(),
});
export type TeamChatSearchHit = z.infer<typeof TeamChatSearchHit>;
export const TeamChatSearch = z.object({ hits: z.array(TeamChatSearchHit), more: z.boolean() });
export type TeamChatSearch = z.infer<typeof TeamChatSearch>;
/** A message not yet confirmed, with the uploaded files it carries, so a retry sends the same message and the same files. */
export const PendingTeamMessage = z.object({
  id: z.uuid(),
  body: z.string(),
  files: z.array(TeamChatFile).max(10).default([]),
  replyTo: TeamChatAnswered.nullable().default(null),
  createdAt: z.string(),
  state: z.enum(["sending", "failed"]),
  error: z.string().nullable(),
});
export type PendingTeamMessage = z.infer<typeof PendingTeamMessage>;
/** Local words and stable send identities, without an authorized history cache. */
export const TeamChatDraft = z.object({ text: z.string(), replyTo: TeamChatAnswered.nullable().default(null), pending: z.array(PendingTeamMessage) });
export type TeamChatDraft = z.infer<typeof TeamChatDraft>;
export type TeamChatStatus = { state: "unavailable" } | { state: "ready"; accountId: string; spaceId: string; reach: "live" | "offline"; chat: TeamChatState };

const scope = { spaceId: SpaceId };
const conversation = { ...scope, conversationId: id };
export const teamChatRpcParams = {
  ...teamChatChannelRpcParams,
  ...teamChatReadRpcParams,
  "teamChat.state": z.object(scope).strict(),
  "teamChat.openDm": z.object({ ...scope, userIds: z.array(id).min(1).max(8) }).strict(),
  "teamChat.timeline": z
    .object({ ...conversation, beforeSeq: seq.optional(), afterSeq: seq.optional() })
    .strict()
    .refine((value) => value.beforeSeq === undefined || value.afterSeq === undefined),
  "teamChat.send": z
    .object({ ...conversation, id: z.uuid(), body: z.string().max(10_000), fileIds: z.array(id).max(10).optional(), replyToId: id.optional() })
    .strict()
    .refine((value) => value.body.trim().length > 0 || (value.fileIds?.length ?? 0) > 0, "Write something or attach a file."),
  "teamChat.react": z.object({ ...conversation, messageId: id, emoji: TeamChatReaction }).strict(),
  "teamChat.pins": z.object(conversation).strict(),
  "teamChat.pin": z.object({ ...conversation, messageId: id, pinned: z.boolean() }).strict(),
  "teamChat.search": z.object({ ...scope, q: z.string().trim().min(2).max(200) }).strict(),
  "teamChat.watch": z.object({ ...conversation, requestId: z.uuid() }).strict(),
  "teamChat.unwatch": z.object({ ...conversation, requestId: z.uuid() }).strict(),
};
export interface TeamChatRpcResults extends TeamChatChannelRpcResults, TeamChatReadRpcResults {
  "teamChat.state": TeamChatStatus;
  "teamChat.openDm": TeamConversation;
  "teamChat.timeline": TeamChatTimeline;
  "teamChat.send": TeamMessage;
  "teamChat.react": TeamMessage;
  "teamChat.pins": TeamChatPins;
  "teamChat.pin": TeamMessage;
  "teamChat.search": TeamChatSearch;
  "teamChat.watch": { ok: boolean };
  "teamChat.unwatch": Record<string, never>;
}
