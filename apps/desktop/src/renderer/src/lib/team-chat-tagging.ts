import { useMemo, useState, type RefObject } from "react";
import { teamChatShortNames } from "@openorc/client";
import type { TeamChatOrclingPick, TeamChatPerson } from "@openorc/protocol";
import { mentionQueryAt } from "./composer-mentions";
import { personTag } from "./message-marks";
import { matchingPeople, type TeamChatTagCandidate } from "../components/TeamChatTagPicker";
import type { ComposerEditorHandle } from "../components/composer-editor/ComposerEditor";

/**
 * The `@` list at the caret: who it offers, the row the keys move, and what a pick writes: a teammate's structured tag,
 * or the plain name of the person's own Orcling, which the draft then calls.
 */
export function useTagging({
  text,
  caret,
  taggable,
  named,
  orclings = [],
  onOrcling,
  editor,
}: {
  text: string;
  caret: number | null;
  taggable: readonly TeamChatPerson[];
  named: readonly TeamChatPerson[];
  /** The person's own Orclings this conversation can call; listed after people. */
  orclings?: readonly TeamChatOrclingPick[];
  onOrcling?: (orcling: TeamChatOrclingPick) => void;
  editor: RefObject<ComposerEditorHandle | null>;
}) {
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const sources = useMemo(() => {
    const short = teamChatShortNames(named);
    return { people: named.map((person, index) => ({ id: person.id, name: short[index] ?? person.name })) };
  }, [named]);
  const query = caret === null ? null : mentionQueryAt(text, caret);
  const matches: TeamChatTagCandidate[] =
    query && query.start !== dismissed
      ? [
          ...matchingPeople(taggable, query.query).map((person) => ({ kind: "person" as const, person })),
          ...matchingPeople(orclings, query.query).map((orcling) => ({ kind: "orcling" as const, orcling })),
        ]
      : [];
  const at = Math.min(cursor, Math.max(0, matches.length - 1));
  const pick = (candidate: TeamChatTagCandidate) => {
    if (!query || caret === null) return;
    if (candidate.kind === "orcling") onOrcling?.(candidate.orcling);
    const tag = candidate.kind === "person" ? `${personTag(candidate.person.id)} ` : `@${candidate.orcling.name} `;
    editor.current?.pick(`${text.slice(0, query.start)}${tag}${text.slice(caret)}`, query.start + tag.length);
    setCursor(0);
  };
  const dismiss = () => setDismissed(query?.start ?? null);
  /** Arrows move, Enter and Tab pick, Escape closes; true when the list took the key. */
  const onKey = (event: KeyboardEvent): boolean => {
    if (!matches.length || event.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") setCursor((at + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    else if (event.key === "Enter" || event.key === "Tab") pick(matches[at]!);
    else if (event.key === "Escape") dismiss();
    else return false;
    event.preventDefault();
    return true;
  };
  return { sources, matches, cursor: at, setCursor, pick, dismiss, onKey, reset: () => setCursor(0) };
}
