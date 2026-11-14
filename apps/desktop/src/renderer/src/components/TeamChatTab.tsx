import type { TeamChatRoute } from "../lib/team-chat-route";
import { useTeamChatContext } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { teamConversationTitle } from "@openorc/client";
import { TeamConversationFace } from "./TeamChatFace";

export function TeamChatTab({ route }: { route: TeamChatRoute }) {
  const scope = useTeamChatContext();
  const read = useTeamChatState();
  const current = scope?.accountId === route.accountId && scope.spaceId === route.spaceId;
  const conversation = current && read.data?.state === "ready" ? read.data.chat.conversations.find((conversation) => conversation.id === route.conversationId) : null;
  return (
    <>
      {conversation ? <TeamConversationFace conversation={conversation} self={route.accountId} className="work-tab-icon" /> : <span className="work-tab-icon" />}
      <span className="work-tab-title">{conversation ? teamConversationTitle(conversation, route.accountId) : "Chat"}</span>
    </>
  );
}
