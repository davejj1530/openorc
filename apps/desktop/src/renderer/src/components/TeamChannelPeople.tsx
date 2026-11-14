import { useState } from "react";
import type { TeamChatPerson } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { Button, Checkbox, Dialog, Input } from "./ui";
import "../styles/team-chat-channels.css";

export function TeamChannelPeople({
  people,
  initial = [],
  onCancel,
  onChoose,
  pending = false,
  error,
}: {
  people: readonly TeamChatPerson[];
  initial?: string[];
  onCancel(): void;
  onChoose(ids: string[]): void;
  pending?: boolean;
  error?: string | null;
}) {
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState(initial);
  const selected = chosen.filter((id) => people.some((person) => person.id === id));
  const visible = people.filter((person) => person.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title="Add people"
      width={460}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <form
        className="team-channel-form"
        onSubmit={(event) => {
          event.preventDefault();
          onChoose(selected);
        }}
      >
        <Input variant="sheet" aria-label="Find people" placeholder="Find people" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="team-channel-people">
          {visible.map((person) => (
            <label className="team-channel-person" key={person.id}>
              <AccountFace name={person.name} image={person.image} />
              <span className="team-channel-person-name">{person.name}</span>
              <Checkbox
                checked={selected.includes(person.id)}
                disabled={pending}
                onChange={(event) => setChosen((ids) => (event.target.checked ? [...ids, person.id] : ids.filter((id) => id !== person.id)))}
              />
            </label>
          ))}
          {!visible.length ? <p className="text-sm text-ink-3">{people.length ? "No people found" : "No people to add"}</p> : null}
        </div>
        {error ? (
          <p className="team-channel-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="team-channel-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!selected.length || pending}>
            {pending ? "Adding…" : "Add people"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
