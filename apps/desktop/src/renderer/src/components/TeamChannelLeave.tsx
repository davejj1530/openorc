import type { TeamConversation } from "@openorc/protocol";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChannelAction } from "../lib/team-channel-actions";
import { closeTeamChatTab } from "../lib/team-chat-group-preferences";
import { core } from "../lib/rpc";
import { Button, Dialog } from "./ui";

export function TeamChannelLeave({ scope, conversation, onCancel, onLeft }: { scope: TeamChatContextValue; conversation: TeamConversation; onCancel(): void; onLeft(): void }) {
  const action = useTeamChannelAction(scope);
  const leave = () =>
    action.run(async () => {
      await core.call("teamChat.leaveChannel", { spaceId: scope.spaceId, conversationId: conversation.id });
      // A membership notification may already have closed this dialog. Close only the tab that was left.
      closeTeamChatTab(scope, conversation.id);
    }, onLeft);
  const offline = scope.reach === "offline";
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title="Leave channel?"
      width={460}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <div className="team-channel-form">
        <p className="text-sm text-ink-3">Leave #{conversation.name}?</p>
        {action.error ? (
          <p className="team-channel-error" role="alert">
            {action.error}
          </p>
        ) : null}
        <div className="team-channel-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={action.pending || offline}
            data-tip={offline ? "Reconnect to leave" : undefined}
            onClick={() => {
              void leave();
            }}
          >
            {action.pending ? "Leaving…" : "Leave channel"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
