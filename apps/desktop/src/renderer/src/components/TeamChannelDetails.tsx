import { useState } from "react";
import type { TeamChatPerson, TeamConversation } from "@openorc/protocol";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChannelDetails } from "../lib/team-channel-queries";
import { useTeamChannelAction } from "../lib/team-channel-actions";
import { useOrganization } from "../lib/organization-context";
import { core } from "../lib/rpc";
import { AccountFace } from "./AccountFace";
import { Button, Dialog } from "./ui";
import { TeamChannelPeople } from "./TeamChannelPeople";
import { TeamChannelLeave } from "./TeamChannelLeave";
import "../styles/team-chat-channels.css";

type DetailsProps = { scope: TeamChatContextValue; conversation: TeamConversation; people: readonly TeamChatPerson[]; onClose(): void };

export function TeamChannelDetails(props: DetailsProps) {
  const read = useTeamChannelDetails(props.scope, props.conversation.id);
  const fresh = read.error ? undefined : read.data;
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title={`#${props.conversation.name}`}
      width={460}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {fresh ? (
        <ChannelDetailsContent {...props} fresh={fresh} refreshing={read.isFetching} />
      ) : (
        <div className="team-channel-form">
          <p className="text-sm text-ink-3" role="status">
            {read.error?.message ?? "Loading channel…"}
          </p>
          {read.error ? (
            <div>
              <Button
                onClick={() => {
                  void read.refetch();
                }}
              >
                Try again
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function ChannelDetailsContent({ scope, conversation, people, onClose, fresh, refreshing }: DetailsProps & { fresh: TeamConversation; refreshing: boolean }) {
  const action = useTeamChannelAction(scope);
  const [dialog, setDialog] = useState<"add" | "leave" | null>(null);
  const offline = scope.reach === "offline";
  const disabled = action.pending || refreshing || offline;
  const canAdd = fresh.canAddMembers && conversation.canAddMembers;
  const canRemove = fresh.canRemoveMembers && conversation.canRemoveMembers;
  const joined = fresh.joined && conversation.joined;
  const target = { spaceId: scope.spaceId, conversationId: conversation.id };
  return (
    <div className="team-channel-form">
      <ChannelDescription conversation={fresh} />
      <ChannelMembers
        people={fresh.members}
        self={scope.accountId}
        canRemove={canRemove}
        disabled={disabled}
        offline={offline}
        onRemove={(userId) => {
          void action.run(() => core.call("teamChat.removeMember", { ...target, userId }));
        }}
      />
      {canAdd ? (
        <div>
          <Button disabled={disabled} data-tip={offline ? "Reconnect to add people" : undefined} onClick={() => setDialog("add")}>
            Add people
          </Button>
        </div>
      ) : null}
      {action.error ? (
        <p className="team-channel-error" role="alert">
          {action.error}
        </p>
      ) : null}
      <div className="team-channel-actions team-channel-details-actions">
        {joined ? (
          <Button variant="ghost" disabled={disabled} data-tip={offline ? "Reconnect to leave" : undefined} onClick={() => setDialog("leave")}>
            Leave channel
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onClose}>Done</Button>
      </div>
      {dialog === "add" && canAdd ? (
        <TeamChannelPeople
          people={people.filter((person) => !fresh.members.some((member) => member.id === person.id))}
          pending={action.pending}
          error={action.error}
          onCancel={() => setDialog(null)}
          onChoose={(userIds) => {
            void action.run(
              () => core.call("teamChat.addMembers", { ...target, userIds }),
              () => setDialog(null),
            );
          }}
        />
      ) : null}
      {dialog === "leave" && joined ? <TeamChannelLeave scope={scope} conversation={fresh} onCancel={() => setDialog(null)} onLeft={onClose} /> : null}
    </div>
  );
}

function ChannelDescription({ conversation }: { conversation: TeamConversation }) {
  const organizationName = useOrganization()?.organization?.name ?? "this organization";
  return (
    <div className="team-channel-description">
      <p>{conversation.private ? "Only people added" : `Everyone in ${organizationName}`}</p>
      {conversation.topic ? <p>{conversation.topic}</p> : null}
    </div>
  );
}

function ChannelMembers({
  people,
  self,
  canRemove,
  disabled,
  offline,
  onRemove,
}: {
  people: readonly TeamChatPerson[];
  self: string;
  canRemove: boolean;
  disabled: boolean;
  offline: boolean;
  onRemove(id: string): void;
}) {
  return (
    <div className="team-channel-people">
      {people.map((person) => (
        <div key={person.id} className="team-channel-person">
          <AccountFace name={person.name} image={person.image} />
          <span className="team-channel-person-name">
            {person.name}
            {person.id === self ? <span className="team-channel-you"> · You</span> : null}
          </span>
          {canRemove && person.id !== self ? (
            <button
              type="button"
              className="team-channel-remove"
              disabled={disabled}
              data-tip={offline ? "Reconnect to remove people" : undefined}
              aria-label={`Remove ${person.name}`}
              onClick={() => onRemove(person.id)}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
