import { useMemo, useState } from "react";
import type { TeamChatPerson } from "@openorc/protocol";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { useTeamChannelAction } from "../lib/team-channel-actions";
import { openTeamConversation } from "../lib/team-chat-open";
import { core } from "../lib/rpc";
import { Button, Dialog, Input } from "./ui";
import { TeamGroupPeople } from "./TeamGroupPeople";
import "../styles/team-chat-groups.css";
import "../styles/team-chat-channels.css";

export interface TeamGroupDialogProps {
  scope: TeamChatContextValue;
  people: readonly TeamChatPerson[];
  onClose(): void;
  onInvite?: () => void;
}
export function TeamGroupDialog({ scope, people, onClose, onInvite }: TeamGroupDialogProps) {
  const choices = useMemo(() => [...new Map(people.filter((person) => person.id !== scope.accountId).map((person) => [person.id, person])).values()], [people, scope.accountId]);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<{ people: typeof choices; ids: string[] }>({ people: choices, ids: [] });
  const selected = selection.ids.filter((id) => choices.some((person) => person.id === id));
  if (selection.people !== choices) setSelection({ people: choices, ids: selected });
  const action = useTeamChannelAction(scope);
  const offline = scope.reach === "offline";
  const selectionReason = selected.length < 2 ? "Choose at least 2 people" : undefined;
  const reason = offline ? "Reconnect to open chat" : selectionReason;
  const toggle = (id: string) => setSelection({ people: choices, ids: selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id] });
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title="New group chat"
      width={460}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className="team-channel-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason || selected.length > 8) return;
          void action.run(
            () => core.call("teamChat.openDm", { spaceId: scope.spaceId, userIds: selected }),
            (conversation) => {
              openTeamConversation(scope, conversation);
              onClose();
            },
          );
        }}
      >
        <Input variant="sheet" aria-label="Find people" placeholder="Find people" value={filter} onChange={(event) => setFilter(event.target.value)} />
        {choices.length ? (
          <TeamGroupPeople people={choices} selected={selected} filter={filter} pending={action.pending} onToggle={toggle} />
        ) : (
          <div className="team-group-empty">
            <p>No one else is here yet.</p>
            {onInvite ? <Button onClick={onInvite}>Invite people</Button> : null}
          </div>
        )}
        {action.error ? (
          <p className="team-channel-error" role="alert">
            {action.error}
          </p>
        ) : null}
        <div className="team-channel-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={Boolean(reason) || action.pending} data-tip={reason}>
            {action.pending ? "Opening…" : "Open chat"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
