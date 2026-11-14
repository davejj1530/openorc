import { teamChatShortNames } from "@openorc/client";
import type { TeamChatPerson } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { Checkbox } from "./ui";
import { X } from "./icons";

export function TeamGroupPeople({
  people,
  selected,
  filter,
  pending,
  onToggle,
}: {
  people: readonly TeamChatPerson[];
  selected: readonly string[];
  filter: string;
  pending: boolean;
  onToggle(id: string): void;
}) {
  const chosen = people.filter((person) => selected.includes(person.id));
  const names = teamChatShortNames(chosen);
  const visible = people.filter((person) => person.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return (
    <>
      {chosen.length ? (
        <div className="team-group-selected">
          {chosen.map((person, index) => (
            <button type="button" className="team-group-person-chip" aria-label={`Remove ${person.name}`} key={person.id} disabled={pending} onClick={() => onToggle(person.id)}>
              <AccountFace name={person.name} image={person.image} />
              <span>{names[index]}</span>
              <X size={12} />
            </button>
          ))}
        </div>
      ) : null}
      <div className="team-channel-people">
        {visible.map((person) => {
          const chosen = selected.includes(person.id);
          const limit = !chosen && selected.length >= 8;
          return (
            <label className="team-channel-person" key={person.id} data-tip={limit ? "Choose up to 8 people" : undefined}>
              <AccountFace name={person.name} image={person.image} />
              <span className="team-channel-person-name">{person.name}</span>
              <Checkbox checked={chosen} disabled={pending || limit} onChange={() => onToggle(person.id)} />
            </label>
          );
        })}
        {!visible.length ? <p className="text-sm text-ink-3">No people found</p> : null}
      </div>
    </>
  );
}
