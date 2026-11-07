import type { FileScope } from "@openorc/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { filterMentions, insertMention, mentionQueryAt, type MentionEntry } from "../lib/composer-mentions";
import { skillSegments } from "../lib/skill-tokens";
import type { SlashCommand } from "./Composer";
import { commandRows, matchingCommands, suggestionKey, type SuggestionRow } from "./composer-commands";
import { ComposerSuggestions } from "./ComposerSuggestions";

interface ComposerInputProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: (duringTurn: boolean) => void;
  onFiles: (files: File[]) => Promise<void>;
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
  fileSearch?: FileScope;
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  onCommandsWanted?: () => void;
  suggestionAnchor: RefObject<HTMLDivElement | null>;
  suggestionSide: "top" | "bottom";
}

/** Stands in while there is no scope; the search is disabled then, so it is never sent. */
const NO_SEARCH: FileScope = { kind: "project", id: "" };

/** The word being typed at the caret, with the character that started it. */
function tokenAtCaret(text: string, caret: number): { start: number; token: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([@/$][^\s]*)$/.exec(before);
  if (!match) return null;
  const token = match[1] ?? "";
  return { start: caret - token.length, token };
}

function commandQueryAt(token: { token: string } | null, commands: SlashCommand[] | undefined): string | null {
  if (!token || !commands?.length) return null;
  const prefix = token.token[0];
  return prefix === "/" || prefix === "$" ? token.token.slice(1) : null;
}

function suggestionLabel(members: boolean, files: boolean): string {
  if (members) return "Mention an Orcling";
  if (files) return "Mention a file";
  return "Commands";
}

/** Owns text interaction: suggestions, selection, focus and the highlight mirror. */
export function ComposerInput(props: ComposerInputProps) {
  const { value, onChange, onSubmit, onFiles, disabled, placeholder, autoFocus, fileSearch, mentions, commands, onCommandsWanted } = props;
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [suggestionsActive, setSuggestionsActive] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);
  const token = useMemo(() => tokenAtCaret(value, caret), [value, caret]);
  const memberQuery = useMemo(() => (mentions?.length ? mentionQueryAt(value, caret) : null), [mentions, value, caret]);
  const memberMatches = useMemo(() => (memberQuery ? filterMentions(mentions ?? [], memberQuery.query) : []), [memberQuery, mentions]);
  const mentionQuery = token?.token.startsWith("@") && fileSearch && !memberMatches.length ? token.token.slice(1) : null;
  const commandPrefix = token?.token[0];
  const commandQuery = commandQueryAt(token, commands);
  // Once per word, and even when the list is empty: a skill installed since it was read is what the picker should show.
  // The callback changes as its read starts and ends, so only the word may ask again, or a failing read would loop.
  const commandWordStart = commandPrefix === "/" || commandPrefix === "$" ? token?.start : undefined;
  const wantCommands = useRef(onCommandsWanted);
  wantCommands.current = onCommandsWanted;
  useEffect(() => {
    if (commandWordStart !== undefined) wantCommands.current?.();
  }, [commandWordStart]);
  const files = useRpc("files.search", { scope: fileSearch ?? NO_SEARCH, query: mentionQuery ?? "", limit: 8 }, { enabled: mentionQuery !== null, staleTime: 10_000 });
  // Skills insert into the prompt; actions clear it, so only offer actions at the start.
  const commandMatches = useMemo(() => matchingCommands(commands, commandQuery, commandPrefix, token?.start), [commandPrefix, commandQuery, commands, token?.start]);
  const caretFrame = useRef<number | null>(null);
  const placeCaret = useCallback((at: number) => {
    if (caretFrame.current !== null) cancelAnimationFrame(caretFrame.current);
    caretFrame.current = requestAnimationFrame(() => {
      caretFrame.current = null;
      const input = textareaRef.current;
      if (!input) return;
      input.setSelectionRange(at, at);
      setCaret(at);
      input.focus();
    });
  }, []);
  useEffect(
    () => () => {
      if (caretFrame.current !== null) cancelAnimationFrame(caretFrame.current);
    },
    [],
  );
  const suggestions: SuggestionRow[] = useMemo(() => {
    if (memberQuery && memberMatches.length) {
      return memberMatches.map((entry) => ({
        key: `mention:${entry.key}`,
        label: `@${entry.name}`,
        hint: entry.hint,
        mention: entry.key,
        pick: () => {
          const next = insertMention(value, memberQuery.start, caret, entry.name);
          onChange(next.text);
          placeCaret(next.caret);
        },
      }));
    }
    if (mentionQuery !== null) {
      return (files.data ?? []).map((filePath) => ({
        key: filePath,
        label: filePath,
        pick: () => {
          if (!token) return;
          const next = `${value.slice(0, token.start)}${filePath} ${value.slice(caret)}`;
          onChange(next);
          placeCaret(token.start + filePath.length + 1);
        },
      }));
    }
    return commandRows(commandMatches, { query: commandQuery, token, caret, value, onChange, placeCaret });
  }, [memberQuery, memberMatches, mentionQuery, files.data, commandMatches, commandQuery, token, caret, value, onChange, placeCaret]);
  // Only a name this project actually has is a token, which is why the set
  // comes from the same commands the popover offers rather than from a shape.
  const skillNames = useMemo(() => new Set((commands ?? []).flatMap((command) => (command.insert ? [command.name, ...(command.aliases ?? [])] : []))), [commands]);
  const skillPrefix = commands?.find((command) => command.insert)?.prefix ?? "/";
  const skillSpans = useMemo(() => skillSegments(value, skillNames, skillPrefix), [value, skillNames, skillPrefix]);
  // Whether the arrow keys chose the row, which is what lets Enter pick one in the middle of a message.
  const [chosen, setChosen] = useState(false);
  useEffect(() => {
    setCursor(0);
    setChosen(false);
  }, [suggestions.length, memberQuery?.query, mentionQuery, commandQuery]);
  const memberList = suggestions.length > 0 && Boolean(suggestions[0]?.mention);
  const suggestionsOpen = suggestionsActive && suggestions.length > 0;

  return (
    <>
      {suggestionsOpen ? (
        <ComposerSuggestions anchor={props.suggestionAnchor} side={props.suggestionSide} members={memberList} cursor={cursor} count={suggestions.length} onDismiss={() => setSuggestionsActive(false)}>
          <div role="listbox" aria-label={suggestionLabel(memberList, mentionQuery !== null)} data-agent-mention-list={memberList || undefined}>
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.key}
                role="option"
                aria-selected={index === cursor}
                data-agent-mention={suggestion.mention}
                onMouseDown={(e) => {
                  e.preventDefault();
                  suggestion.pick();
                }}
                // A move, not an enter: a row scrolling under a still pointer must not take the selection from the arrow keys.
                onMouseMove={() => setCursor(index)}
                className="composer-suggestion"
              >
                {/* The label is the thing being inserted, so the hint gives way first. A
                    skill's description runs to a paragraph and would otherwise squeeze the
                    name it belongs to down to nothing. Half the row is the ceiling, so a
                    long file path still truncates rather than crowding out its own hint. */}
                <span className={cn("composer-suggestion-label", suggestion.insert && "skill-token")} data-mono={memberList ? undefined : true}>
                  {suggestion.label}
                </span>
                {suggestion.hint ? <span className="composer-suggestion-hint">{suggestion.hint}</span> : null}
              </button>
            ))}
          </div>
        </ComposerSuggestions>
      ) : null}
      <div className="composer-input-shell">
        <div ref={mirrorRef} aria-hidden="true" className="composer-input-mirror">
          {skillSpans.map((segment, index) =>
            segment.skill ? (
              <mark key={index} className="skill-token">
                {segment.text}
              </mark>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
          {/* A trailing newline collapses without something after it, and the
              mirror would then scroll a line short of the textarea. */}
          {"\n"}
        </div>
        <textarea
          ref={textareaRef}
          onScroll={(e) => {
            if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          rows={1}
          aria-label="Message"
          disabled={disabled}
          value={value}
          onFocus={() => setSuggestionsActive(true)}
          onBlur={() => setSuggestionsActive(false)}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
            setSuggestionsActive(true);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length > 0) {
              e.preventDefault();
              void onFiles(files);
            }
          }}
          onKeyDown={(e) => {
            const endsMessage = (token?.start ?? 0) > 0 && value.slice(caret).trim() === "";
            const action = suggestionsOpen ? suggestionKey({ ...e, isComposing: e.nativeEvent.isComposing }, suggestions[cursor], { chosen, endsMessage }) : "pass";
            if (action === "down" || action === "up") {
              e.preventDefault();
              setChosen(true);
              setCursor((current) => (action === "down" ? Math.min(suggestions.length - 1, current + 1) : Math.max(0, current - 1)));
              return;
            }
            if (action === "pick" || action === "close") {
              e.preventDefault();
              if (action === "pick") suggestions[cursor]?.pick();
              else setSuggestionsActive(false);
              return;
            }
            if (action === "send") setSuggestionsActive(false);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSubmit(e.metaKey || e.ctrlKey);
            }
          }}
          placeholder={placeholder}
          className="composer-input min-w-0 resize-none border-0 outline-none text-ink"
        />
      </div>
    </>
  );
}
