import { useMemo, useRef, useState } from "react";
import { teamChatShortNames } from "@openorc/client";
import type { TeamChatPerson } from "@openorc/protocol";
import { mentionQueryAt } from "../lib/composer-mentions";
import { personTag } from "../lib/message-marks";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor/ComposerEditor";
import { ArrowUp } from "./icons";
import { matchingPeople, TeamChatTagPicker } from "./TeamChatTagPicker";
import { Tooltip } from "./ui";

export interface TeamChatComposerProps {
  text: string;
  placeholder: string;
  reason: string | null;
  onChange(text: string): void;
  onSend(): void;
  /** Who this conversation may tag; empty offers no list. */
  taggable?: readonly TeamChatPerson[];
  /** Everyone a tag here may name, so a draft or a sent tag reads as a name. */
  named?: readonly TeamChatPerson[];
}

export function TeamChatComposer({ text, placeholder, reason, onChange, onSend, taggable = [], named = [] }: TeamChatComposerProps) {
  const editor = useRef<ComposerEditorHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const people = useMemo(() => {
    const short = teamChatShortNames(named);
    return named.map((person, index) => ({ id: person.id, name: short[index] ?? person.name }));
  }, [named]);
  const sources = useMemo(() => ({ people }), [people]);
  const query = caret === null ? null : mentionQueryAt(text, caret);
  const matches = query && query.start !== dismissed ? matchingPeople(taggable, query.query) : [];
  const listOpen = matches.length > 0;
  const disabled = Boolean(reason) || !text.trim() || text.length > 10_000;
  const send = () => {
    if (!disabled) onSend();
  };
  const pick = (person: TeamChatPerson) => {
    if (!query || caret === null) return;
    const tag = `${personTag(person.id)} `;
    editor.current?.pick(`${text.slice(0, query.start)}${tag}${text.slice(caret)}`, query.start + tag.length);
    setCursor(0);
  };
  return (
    <div className="composer-padding team-chat-compose">
      <div className="mx-auto max-w-chat w-full composer">
        <div className="composer-shell" ref={shell}>
          {listOpen ? (
            <TeamChatTagPicker anchor={shell} people={matches} cursor={Math.min(cursor, matches.length - 1)} onCursor={setCursor} onPick={pick} onDismiss={() => setDismissed(query?.start ?? null)} />
          ) : null}
          <div className="composer-prompt">
            <ComposerEditor
              value={text}
              onChange={(change) => {
                setCaret(change.caret);
                if (change.text !== text) setCursor(0);
                onChange(change.text);
              }}
              sources={sources}
              onKeyDown={(event) => {
                if (listOpen && !event.isComposing) {
                  const at = Math.min(cursor, matches.length - 1);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setCursor((at + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                    return true;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const person = matches[at];
                    if (person) pick(person);
                    return true;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDismissed(query?.start ?? null);
                    return true;
                  }
                }
                if (event.key !== "Enter" || event.shiftKey || event.isComposing) return false;
                event.preventDefault();
                send();
                return true;
              }}
              onFiles={() => {}}
              disabled={false}
              placeholder={placeholder}
              completion={{}}
              onFocus={() => {}}
              onBlur={() => setCaret(null)}
              handle={editor}
            />
          </div>
          <div className="composer-bar justify-end">
            <Tooltip label={reason ?? (text.length > 10_000 ? "Messages can have up to 10,000 characters." : "Send")}>
              <button type="button" className="composer-send" aria-label="Send" disabled={disabled} onClick={send}>
                <ArrowUp size={18} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
