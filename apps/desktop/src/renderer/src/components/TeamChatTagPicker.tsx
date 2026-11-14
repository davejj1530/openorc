import { useId, type RefObject } from "react";
import type { TeamChatPerson } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { ComposerSuggestions } from "./ComposerSuggestions";
import "../styles/team-chat-unread.css";

/** Teammates the `@` word at the caret may tag, by face and full name; picking writes their structured tag. */
export function TeamChatTagPicker({
  anchor,
  people,
  cursor,
  onCursor,
  onPick,
  onDismiss,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  people: readonly TeamChatPerson[];
  cursor: number;
  onCursor(index: number): void;
  onPick(person: TeamChatPerson): void;
  onDismiss(): void;
}) {
  const id = useId();
  return (
    <ComposerSuggestions anchor={anchor} side="top" members cursor={cursor} count={people.length} onDismiss={onDismiss}>
      <div id={id} role="listbox" aria-label="Tag a person">
        {people.map((person, index) => (
          <button
            key={person.id}
            id={`${id}-${index}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={index === cursor}
            className="composer-suggestion team-chat-tag-option"
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(person);
            }}
            onMouseMove={() => onCursor(index)}
          >
            <AccountFace name={person.name} image={person.image} />
            <span className="composer-suggestion-label">{person.name}</span>
          </button>
        ))}
      </div>
    </ComposerSuggestions>
  );
}

/** Who matches the `@` word: by the start of any part of their name. */
export function matchingPeople(people: readonly TeamChatPerson[], query: string): TeamChatPerson[] {
  const needle = query.toLocaleLowerCase();
  return people
    .filter(
      (person) =>
        person.name
          .toLocaleLowerCase()
          .split(/\s+/)
          .some((part) => part.startsWith(needle)) || person.name.toLocaleLowerCase().startsWith(needle),
    )
    .slice(0, 8);
}
