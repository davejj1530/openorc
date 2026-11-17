import { useId, type RefObject } from "react";
import type { TeamChatOrclingPick, TeamChatPerson } from "@openorc/protocol";
import { AccountFace } from "./AccountFace";
import { OrclingAvatar } from "./OrclingAvatar";
import { ComposerSuggestions } from "./ComposerSuggestions";
import "../styles/team-chat-unread.css";
import "../styles/team-chat-orcling.css";

/** Who the `@` word can name: a teammate, tagged, or one of the person's own Orclings, called once. */
export type TeamChatTagCandidate = { kind: "person"; person: TeamChatPerson } | { kind: "orcling"; orcling: TeamChatOrclingPick };
const candidateKey = (candidate: TeamChatTagCandidate) => (candidate.kind === "person" ? `person:${candidate.person.id}` : `orcling:${candidate.orcling.localOrclingId}`);

/** Teammates the `@` word at the caret may tag, by face and full name, then the person's own Orclings; picking writes the tag or the call. */
export function TeamChatTagPicker({
  anchor,
  candidates,
  cursor,
  onCursor,
  onPick,
  onDismiss,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  candidates: readonly TeamChatTagCandidate[];
  cursor: number;
  onCursor(index: number): void;
  onPick(candidate: TeamChatTagCandidate): void;
  onDismiss(): void;
}) {
  const id = useId();
  return (
    <ComposerSuggestions anchor={anchor} side="top" members cursor={cursor} count={candidates.length} onDismiss={onDismiss}>
      <div id={id} role="listbox" aria-label="Tag a person or call your Orcling">
        {candidates.map((candidate, index) => (
          <button
            key={candidateKey(candidate)}
            id={`${id}-${index}`}
            type="button"
            tabIndex={-1}
            role="option"
            aria-selected={index === cursor}
            className="composer-suggestion team-chat-tag-option"
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(candidate);
            }}
            onMouseMove={() => onCursor(index)}
          >
            {candidate.kind === "person" ? (
              <span className="composer-suggestion-label">
                <AccountFace name={candidate.person.name} image={candidate.person.image} />
                {candidate.person.name}
              </span>
            ) : (
              <>
                <span className="composer-suggestion-label">
                  <OrclingAvatar orcling={candidate.orcling} size={20} className="team-chat-tag-orcling" />
                  {candidate.orcling.name}
                </span>
                <span className="composer-suggestion-hint">Your Orcling</span>
              </>
            )}
          </button>
        ))}
      </div>
    </ComposerSuggestions>
  );
}

/** Who matches the `@` word: by the start of any part of their name. */
export function matchingPeople<T extends { name: string }>(people: readonly T[], query: string): T[] {
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
