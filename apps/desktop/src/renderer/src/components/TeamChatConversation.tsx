import { useState } from "react";
import type { TeamChatFeature, TeamChatPerson, TeamConversation, TeamMessage } from "@openorc/protocol";
import type { TeamChatRoute } from "../lib/team-chat-route";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChatConversation } from "../lib/use-team-chat-conversation";
import { useTeamChatVisible } from "../lib/team-chat-visibility";
import { TeamChat } from "./TeamChat";
import { TeamChatPins } from "./TeamChatPins";
import { jumpToTeamMessage } from "../lib/team-chat-jump";
import { TeamChannelJoin } from "./TeamChannelJoin";
import { TeamChannelDetails } from "./TeamChannelDetails";
import { TeamChatDetails } from "./TeamChatDetails";
import { useTeamChatFilePlace } from "../lib/team-chat-files";

export function TeamChatConversation({
  scope,
  target,
  conversation,
  people,
  features,
}: {
  scope: TeamChatContextValue;
  target: TeamChatRoute;
  conversation: TeamConversation;
  people: TeamChatPerson[];
  /** What the server offers; a control appears only for a feature it lists. */
  features: ReadonlySet<TeamChatFeature>;
}) {
  const content = useTeamChatConversation(scope, target, conversation, { unread: features.has("unread"), replies: features.has("replies"), pins: features.has("pins") });
  const place = useTeamChatFilePlace(scope, conversation.id, features.has("files") && conversation.joined);
  const [details, setDetails] = useState(false);
  const visible = useTeamChatVisible();
  if (details && !visible) setDetails(false);
  const names = conversation.kind === "channel" || (conversation.participants?.length ?? 0) > 2;
  const hasDetails = features.has(conversation.kind === "channel" ? "channels" : "groups");
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
        tags={features.has("unread")}
        files={place}
        pins={
          features.has("pins") ? (
            <TeamChatPins
              scope={scope}
              conversationId={conversation.id}
              people={people}
              onOpen={(message) => jumpToTeamMessage(target, message)}
              {...(content.onPin && { onUnpin: (message: TeamMessage) => content.onPin?.(message, false) })}
            />
          ) : undefined
        }
      />
      {details && hasDetails ? detail : null}
    </>
  );
}
