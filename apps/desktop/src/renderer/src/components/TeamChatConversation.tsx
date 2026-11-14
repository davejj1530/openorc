import { useState } from "react";
import type { TeamChatPerson, TeamConversation } from "@openorc/protocol";
import type { TeamChatRoute } from "../lib/team-chat-route";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatConversation } from "../lib/use-team-chat-conversation";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { TeamChat } from "./TeamChat";
import { TeamChannelJoin } from "./TeamChannelJoin";
import { TeamChannelDetails } from "./TeamChannelDetails";

export function TeamChatConversation({
  scope,
  target,
  conversation,
  people,
  channels,
}: {
  scope: TeamChatContextValue;
  target: TeamChatRoute;
  conversation: TeamConversation;
  people: TeamChatPerson[];
  channels: boolean;
}) {
  const content = useTeamChatConversation(scope, target, conversation);
  const [details, setDetails] = useState(false);
  const visible = useTeamChatVisible();
  if (details && !visible) setDetails(false);
  const names = conversation.kind === "channel" || (conversation.participants?.length ?? 0) > 2;
  return (
    <>
      <TeamChat
        {...content}
        conversation={conversation}
        people={people}
        names={names}
        {...(!conversation.joined && { footer: <TeamChannelJoin scope={scope} conversationId={conversation.id} /> })}
        {...(channels && conversation.kind === "channel" && { onDetails: () => setDetails(true) })}
      />
      {details && channels ? <TeamChannelDetails scope={scope} conversation={conversation} people={people} onClose={() => setDetails(false)} /> : null}
    </>
  );
}
