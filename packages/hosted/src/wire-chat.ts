import {
  type OrclingLook,
  TeamChatPresence,
  TeamOwnerOrclingCall,
  TeamChatPins,
  TeamChatRead,
  TeamChatSearch,
  TeamChatState,
  TeamChatTimeline,
  TeamConversation,
  TeamMessage,
} from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
const conversationPath = (id: string) => `/chat/conversations/${encodeURIComponent(id)}`;
const callPath = (id: string) => `/chat/calls/${encodeURIComponent(id)}`;
/** The calling message and up to 50 before it, as the server lets the owner's app read them to answer. */
export const orclingClaim = z.object({
  call: TeamOwnerOrclingCall.shape.call,
  context: z.object({
    callingMessageId: z.string(),
    messages: z.array(z.object({ id: z.string(), seq: z.number(), speaker: z.string(), body: z.string(), files: z.array(z.object({ name: z.string(), bytes: z.number() })) })),
  }),
});
export type OrclingClaim = z.infer<typeof orclingClaim>;
export const CHAT_ROUTES = {
  state: route("GET", "/chat/state", TeamChatState),
  openDm: route("POST", "/chat/dms", TeamConversation),
  conversation: (id: string) => route("GET", conversationPath(id), TeamConversation),
  createChannel: route("POST", "/chat/channels", TeamConversation),
  joinChannel: (id: string) => route("POST", `${conversationPath(id)}/join`, TeamConversation),
  leaveChannel: (id: string) =>
    route(
      "POST",
      `${conversationPath(id)}/leave`,
      z.null().transform(() => ({})),
    ),
  addMembers: (id: string) => route("POST", `${conversationPath(id)}/members`, TeamConversation),
  removeMember: (id: string, userId: string) => route("DELETE", `${conversationPath(id)}/members/${encodeURIComponent(userId)}`, TeamConversation),
  timeline: (id: string, cursor: { beforeSeq?: number; afterSeq?: number }) => {
    let query = "";
    if (cursor.beforeSeq !== undefined) query = `?beforeSeq=${cursor.beforeSeq}`;
    else if (cursor.afterSeq !== undefined) query = `?afterSeq=${cursor.afterSeq}`;
    return route("GET", `${conversationPath(id)}/timeline${query}`, TeamChatTimeline);
  },
  send: (id: string) => route("POST", `${conversationPath(id)}/messages`, TeamMessage),
  react: (id: string) => route("POST", `/chat/messages/${encodeURIComponent(id)}/reactions`, TeamMessage),
  presence: route("GET", "/chat/presence", TeamChatPresence),
  orclingCall: (id: string) => route("GET", callPath(id), TeamOwnerOrclingCall),
  claimCall: (id: string) => route("POST", `${callPath(id)}/claim`, orclingClaim),
  renewCall: (id: string) =>
    route(
      "POST",
      `${callPath(id)}/heartbeat`,
      z.null().transform(() => ({})),
    ),
  answerCall: (id: string) => route("POST", `${callPath(id)}/answer`, TeamMessage),
  failCall: (id: string) => route("POST", `${callPath(id)}/fail`, TeamOwnerOrclingCall),
  retryCall: (id: string) => route("POST", `${callPath(id)}/retry`, TeamOwnerOrclingCall),
  search: (q: string) => route("GET", `/chat/search?${new URLSearchParams({ q })}`, TeamChatSearch),
  pins: (id: string) => route("GET", `${conversationPath(id)}/pins`, TeamChatPins),
  pin: (id: string, pinned: boolean) => route(pinned ? "POST" : "DELETE", `/chat/messages/${encodeURIComponent(id)}/pin`, TeamMessage),
  seen: (id: string) => route("PUT", `${conversationPath(id)}/seen`, TeamChatRead),
  unreadSpaces: route("GET", "/chat/unread-spaces", z.object({ spaces: z.array(z.object({ spaceId: z.string() })) })),
};
export const chatWatch = z.object({ spaceId: z.string(), conversationId: z.string(), requestId: z.string() });
export type ChatWatch = z.infer<typeof chatWatch>;
export const chatWatched = chatWatch.extend({ ok: z.boolean() });
export const chatMessage = z.object({ spaceId: z.string(), conversationId: z.string(), message: TeamMessage });
export const chatRead = z.object({ spaceId: z.string(), conversationId: z.string(), read: TeamChatRead });

/** What the owner's app sends with a message that calls its Orcling; the secret never leaves the app's core otherwise. */
export type WireOrclingCall = { id: string; localOrclingId: string; name: string; look: OrclingLook; runnerSecret: string };
/** Someone's apps came or went in an organization; it names nobody. */
export const chatPresenceNudge = z.object({ spaceId: z.string() });
