import { useState } from "react";
import type { TeamChatPerson, TeamConversation } from "@openorc/protocol";
import type { TeamChatRoute } from "../lib/team-chat-route";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatConversation } from "../lib/use-team-chat-conversation";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { TeamChat } from "./TeamChat";
import { TeamChannelJoin } from "./TeamChannelJoin";
import { TeamChannelDetails } from "./TeamChannelDetails";
import { TeamChatDetails } from "./TeamChatDetails";

export function TeamChatConversation({
  scope,
  target,
  conversation,
  people,
  channels,
  groups,
}: {
  scope: TeamChatContextValue;
  target: TeamChatRoute;
  conversation: TeamConversation;
  people: TeamChatPerson[];
  channels: boolean;
  groups: boolean;
}) {
  const content = useTeamChatConversation(scope, target, conversation);
  const [details, setDetails] = useState(false);
  const visible = useTeamChatVisible();
  if (details && !visible) setDetails(false);
  const names = conversation.kind === "channel" || (conversation.participants?.length ?? 0) > 2;
  const hasDetails = conversation.kind === "channel" ? channels : groups;
  const detail =
    conversation.kind === "channel" ? (
      <TeamChannelDetails scope={scope} conversation={conversation} people={people} onClose={() => setDetails(false)} />
    ) : (
      <TeamChatDetails scope={scope} conversation={conversation} onClose={() => setDetails(false)} />
    );
  return (
    <>
      <TeamChat
        {...content}
        conversation={conversation}
        people={people}
        names={names}
        {...(!conversation.joined && { footer: <TeamChannelJoin scope={scope} conversationId={conversation.id} /> })}
        {...(hasDetails && { onDetails: () => setDetails(true) })}
      />
      {details && hasDetails ? detail : null}
    </>
  );
}
