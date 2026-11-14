import { teamConversationTitle } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChannelDetails } from "../lib/team-channel-queries";
import { closeTeamGroup } from "../lib/team-chat-group-preferences";
import { AccountFace } from "./AccountFace";
import { Button, Dialog } from "./ui";
import "../styles/team-chat-channels.css";
import "../styles/team-chat-groups.css";

export interface TeamChatDetailsProps {
  scope: TeamChatContextValue;
  conversation: TeamConversation;
  onClose(): void;
}
export function TeamChatDetails({ scope, conversation, onClose }: TeamChatDetailsProps) {
  const read = useTeamChannelDetails(scope, conversation.id);
  const fresh = read.error ? undefined : read.data;
  const participants = fresh?.participants ?? [];
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title={teamConversationTitle(conversation, scope.accountId)}
      width={460}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="team-channel-form">
        {fresh ? (
          <>
            <p className="team-channel-description">{participants.length} people</p>
            <div className="team-channel-people">
              {participants.map(({ person, inOrganization }) => (
                <div className="team-channel-person" key={person.id}>
                  <AccountFace name={person.name} image={person.image} />
                  <span className="team-channel-person-name" data-tip={person.name}>
                    {person.name}
                    {person.id === scope.accountId ? <span className="team-channel-you"> · You</span> : null}
                  </span>
                  {!inOrganization ? <span className="team-group-departed">No longer in the organization</span> : null}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div>
            <p className="text-sm text-ink-3" role="status">
              {read.error?.message ?? "Loading chat…"}
            </p>
            {read.error ? (
              <Button
                onClick={() => {
                  void read.refetch();
                }}
              >
                Try again
              </Button>
            ) : null}
          </div>
        )}
        <div className="team-channel-actions team-channel-details-actions">
          {participants.length > 2 && fresh ? (
            <Button
              variant="ghost"
              onClick={() => {
                closeTeamGroup(scope, fresh);
                onClose();
              }}
            >
              Close chat
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
