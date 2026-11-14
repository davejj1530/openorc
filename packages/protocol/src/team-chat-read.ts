import { z } from "zod";
import { SpaceId } from "./spaces.js";
import type { TeamChatRead } from "./team-chat.js";

const id = z.string().min(1).max(200);

export const teamChatReadRpcParams = {
  /** The latest message this window displayed, focused and visible; the server never moves the place back. */
  "teamChat.seen": z.object({ spaceId: SpaceId, conversationId: id, messageId: id }).strict(),
  /** Organizations of this account with unread chat, for one neutral mark on the switcher. */
  "teamChat.unreadSpaces": z.object({}).strict(),
};

export interface TeamChatReadRpcResults {
  "teamChat.seen": TeamChatRead;
  "teamChat.unreadSpaces": { spaceIds: string[] };
}
