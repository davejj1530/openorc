import { z } from "zod";
import { SpaceId } from "./spaces.js";
import type { TeamConversation } from "./team-chat.js";

const id = z.string().min(1).max(200);
const target = { spaceId: SpaceId, conversationId: id };

export const teamChatChannelRpcParams = {
  "teamChat.conversation": z.object(target).strict(),
  "teamChat.createChannel": z
    .object({
      spaceId: SpaceId,
      name: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use letters, numbers and dashes, starting with a letter or number."),
      topic: z.string().max(200).optional(),
      private: z.boolean().optional(),
      userIds: z.array(id).max(200).optional(),
    })
    .strict(),
  "teamChat.joinChannel": z.object(target).strict(),
  "teamChat.leaveChannel": z.object(target).strict(),
  "teamChat.addMembers": z.object({ ...target, userIds: z.array(id).min(1).max(200) }).strict(),
  "teamChat.removeMember": z.object({ ...target, userId: id }).strict(),
};

export interface TeamChatChannelRpcResults {
  "teamChat.conversation": TeamConversation;
  "teamChat.createChannel": TeamConversation;
  "teamChat.joinChannel": TeamConversation;
  "teamChat.leaveChannel": Record<string, never>;
  "teamChat.addMembers": TeamConversation;
  "teamChat.removeMember": TeamConversation;
}
