import { useState } from "react";
import { teamChatRpcParams, type TeamChatPerson } from "@openorc/protocol";
import { cn } from "../lib/cn";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { core } from "../lib/rpc";
import { useTeamChannelAction } from "../lib/team-channel-actions";
import { openTeamConversation } from "../lib/team-chat-open";
import { Button, Dialog, Input } from "./ui";
import { Check, Hash, Lock, Plus } from "./icons";
import { TeamChannelPeople } from "./TeamChannelPeople";
import { TeamChatFace } from "./TeamChatFace";
import "../styles/team-chat-channels.css";

export function TeamChannelDialog({ scope, organizationName, people, onClose }: { scope: TeamChatContextValue; organizationName: string; people: readonly TeamChatPerson[]; onClose(): void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [privateChannel, setPrivate] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const chosenPeople = people.filter((person) => chosen.includes(person.id));
  const [validation, setValidation] = useState<ChannelError | null>(null);
  const action = useTeamChannelAction(scope);
  const offline = scope.reach === "offline";
  const submit = () => {
    const input = teamChatRpcParams["teamChat.createChannel"].safeParse({ spaceId: scope.spaceId, name, topic, private: privateChannel, userIds: chosen });
    const issue = input.success ? undefined : input.error.issues[0];
    setValidation(issue ? { field: issue.path[0] === "name" ? "name" : "form", message: issue.message } : null);
    if (!input.success) return;
    void action.run(
      () => core.call("teamChat.createChannel", input.data),
      (conversation) => {
        openTeamConversation(scope, conversation);
        onClose();
      },
    );
  };
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title="New channel"
      width={460}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <form
        className="team-channel-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="team-channel-field">
          <span>Name</span>
          <Input variant="sheet" value={name} maxLength={40} disabled={action.pending} onChange={(event) => setName(event.target.value)} />
        </label>
        <ChannelErrorMessage at="name" validation={validation} error={action.error} />
        <label className="team-channel-field">
          <span>Topic</span>
          <Input variant="sheet" value={topic} maxLength={200} disabled={action.pending} onChange={(event) => setTopic(event.target.value)} />
        </label>
        <div className="team-channel-audience" role="group" aria-label="Audience">
          <AudienceChoice privateChannel={false} selected={!privateChannel} disabled={action.pending} organizationName={organizationName} choose={() => setPrivate(false)} />
          <AudienceChoice privateChannel selected={privateChannel} disabled={action.pending} organizationName={organizationName} choose={() => setPrivate(true)} />
        </div>
        <div className="team-channel-field">
          <span>People</span>
          <button type="button" className="team-channel-choose" disabled={action.pending} onClick={() => setPicking(true)}>
            {chosenPeople.length ? <TeamChatFace people={chosenPeople} /> : <Plus size={16} />}
            <span data-tip={chosenPeople.map((person) => person.name).join(", ")}>{chosenPeople.length ? chosenPeople.map((person) => person.name).join(", ") : "Add people"}</span>
          </button>
        </div>
        <ChannelErrorMessage at="form" validation={validation} error={action.error} />
        <div className="team-channel-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || offline || action.pending} data-tip={offline ? "Reconnect to create a channel" : undefined}>
            {action.pending ? "Creating…" : "Create channel"}
          </Button>
        </div>
      </form>
      {picking ? (
        <TeamChannelPeople
          people={people.filter((person) => person.id !== scope.accountId)}
          initial={chosen}
          onCancel={() => setPicking(false)}
          onChoose={(ids) => {
            setChosen(ids);
            setPicking(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}

type ChannelError = { field: "name" | "form"; message: string };
function ChannelErrorMessage({ at, validation, error }: { at: ChannelError["field"]; validation: ChannelError | null; error: string | null }) {
  const problem = validation ?? (error ? { field: error.endsWith("already exists.") ? "name" : "form", message: error } : null);
  return problem?.field === at ? (
    <p className="team-channel-error" role="alert">
      {problem.message}
    </p>
  ) : null;
}

function AudienceChoice({ privateChannel, selected, disabled, organizationName, choose }: { privateChannel: boolean; selected: boolean; disabled: boolean; organizationName: string; choose(): void }) {
  const Icon = privateChannel ? Lock : Hash;
  return (
    <button type="button" className={cn("team-channel-audience-choice", selected && "team-channel-audience-selected")} aria-pressed={selected} disabled={disabled} onClick={choose}>
      <Icon size={18} />
      <span>
        <span>{privateChannel ? "Private" : "Public"}</span>
        <span className="team-channel-audience-description" data-tip={privateChannel ? undefined : `Everyone in ${organizationName}`}>
          {privateChannel ? "Only people added" : `Everyone in ${organizationName}`}
        </span>
      </span>
      {selected ? <Check size={14} /> : null}
    </button>
  );
}
