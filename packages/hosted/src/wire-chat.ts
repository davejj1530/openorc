import { TeamChatPins, TeamChatRead, TeamChatState, TeamChatTimeline, TeamConversation, TeamMessage } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

const route = <T>(method: Route<T>["method"], path: string, reply: z.ZodType<T>): Route<T> => ({ method, path, reply });
const conversationPath = (id: string) => `/chat/conversations/${encodeURIComponent(id)}`;
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
