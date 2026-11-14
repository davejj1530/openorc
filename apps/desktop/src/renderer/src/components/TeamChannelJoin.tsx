import type { TeamChatContextValue } from "../lib/team-chat-context";
import { core } from "../lib/rpc";
import { useTeamChannelAction } from "../lib/team-channel-actions";
import { Button } from "./ui";
import "../styles/team-chat-channels.css";

export function TeamChannelJoin({ scope, conversationId }: { scope: TeamChatContextValue; conversationId: string }) {
  const action = useTeamChannelAction(scope);
  const offline = scope.reach === "offline";
  return (
    <div className="team-channel-join">
      {action.error ? (
        <p role="alert" className="team-channel-error">
          {action.error}
        </p>
      ) : null}
      <Button
        variant="primary"
        disabled={offline || action.pending}
        data-tip={offline ? "Reconnect to join" : undefined}
        onClick={() => {
          void action.run(() => core.call("teamChat.joinChannel", { spaceId: scope.spaceId, conversationId }));
        }}
      >
        {action.pending ? "Joining…" : "Join channel"}
      </Button>
    </div>
  );
}
