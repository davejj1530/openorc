import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AtSign, Slash, Zap } from "./icons";
import type { SlashCommand } from "./Composer";
import { ComposerSuggestions } from "./ComposerSuggestions";
import { cn } from "../lib/cn";
import { useRpc } from "../lib/query";
import { filterMentions, insertMention, mentionQueryAt, type MentionEntry } from "../lib/composer-mentions";
import { skillSegments } from "../lib/skill-tokens";

interface ComposerInputProps {
  value: string;
  onChange: (text: string) => void;
  onSubmit: (duringTurn: boolean) => void;
  onFiles: (files: File[]) => Promise<void>;
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
  projectId?: string;
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  suggestionAnchor: RefObject<HTMLDivElement | null>;
  suggestionSide: "top" | "bottom";
}

/** The word being typed at the caret, with the character that started it. */
function tokenAtCaret(text: string, caret: number): { start: number; token: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([@/$][^\s]*)$/.exec(before);
  if (!match) return null;
  const token = match[1] ?? "";
  return { start: caret - token.length, token };
}

function matchingCommands(commands: SlashCommand[] | undefined, query: string | null, prefix: string | undefined, start: number | undefined): SlashCommand[] {
  if (query === null) return [];
  // Slash opens the skill picker for either harness; selection still inserts its native prefix.
  return (commands ?? []).filter((command) => (command.insert ? prefix === "/" || command.prefix === prefix : prefix === "/" && start === 0) && command.name.startsWith(query.toLowerCase()));
}

function commandQueryAt(token: { token: string } | null, commands: SlashCommand[] | undefined): string | null {
  if (!token || !commands?.length) return null;
  const prefix = token.token[0];
  return prefix === "/" || prefix === "$" ? token.token.slice(1) : null;
}

/** Owns text interaction: suggestions, selection, focus and the highlight mirror. */
export function ComposerInput(props: ComposerInputProps) {
  const { value, onChange, onSubmit, onFiles, disabled, placeholder, autoFocus, projectId, mentions, commands } = props;
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);
  const token = useMemo(() => tokenAtCaret(value, caret), [value, caret]);
  const memberQuery = useMemo(() => (mentions?.length ? mentionQueryAt(value, caret) : null), [mentions, value, caret]);
  const memberMatches = useMemo(() => (memberQuery ? filterMentions(mentions ?? [], memberQuery.query) : []), [memberQuery, mentions]);
  const mentionQuery = token?.token.startsWith("@") && projectId && !memberMatches.length ? token.token.slice(1) : null;
  const commandPrefix = token?.token[0];
  const commandQuery = commandQueryAt(token, commands);
  const files = useRpc("files.search", { projectId: projectId ?? "", query: mentionQuery ?? "", limit: 8 }, { enabled: mentionQuery !== null, staleTime: 10_000 });
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
  const suggestions: { key: string; label: string; hint?: string; mention?: string; insert?: boolean; pick: () => void }[] = useMemo(() => {
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
    return commandMatches.map((command) => ({
      key: `${command.insert ? command.prefix : "/"}${command.name}`,
      label: `${command.insert ? command.prefix : "/"}${command.name}`,
      hint: command.hint,
      insert: command.insert === true,
      pick: () => {
        if (command.insert) {
          // Preserve the harness's invocation prefix when inserting the skill.
          if (!token) return;
          const text = `${command.prefix}${command.name} `;
          onChange(`${value.slice(0, token.start)}${text}${value.slice(caret)}`);
          placeCaret(token.start + text.length);
          return;
        }
        onChange("");
        command.run();
      },
    }));
  }, [memberQuery, memberMatches, mentionQuery, files.data, commandMatches, token, caret, value, onChange, placeCaret]);
  // Keep ten suggestions visible; typing narrows the rest.
  // Only a name this project actually has is a token, which is why the set
  // comes from the same commands the popover offers rather than from a shape.
  const skillNames = useMemo(() => new Set((commands ?? []).filter((command) => command.insert).map((command) => command.name)), [commands]);
  const skillPrefix = commands?.find((command) => command.insert)?.prefix ?? "/";
  const skillSpans = useMemo(() => skillSegments(value, skillNames, skillPrefix), [value, skillNames, skillPrefix]);
  const shown = useMemo(() => suggestions.slice(0, 10), [suggestions]);
  const hidden = suggestions.length - shown.length;
  useEffect(() => setCursor(0), [suggestions.length, memberQuery?.query, mentionQuery, commandQuery]);
  const memberList = suggestions.length > 0 && Boolean(suggestions[0]?.mention);
  let suggestionsLabel = "Commands";
  if (memberList) suggestionsLabel = "Mention a member";
  else if (mentionQuery !== null) suggestionsLabel = "Mention a file";

  return (
    <>
      {suggestions.length > 0 ? (
        <ComposerSuggestions anchor={props.suggestionAnchor} side={props.suggestionSide} members={memberList} cursor={cursor}>
          {/* The count belongs to the popover, not to the listbox: a listbox
                may only hold options, and a stray paragraph inside one is read
                out as if it were selectable. */}
          <div role="listbox" aria-label={suggestionsLabel} data-team-mention-list={memberList || undefined}>
            {shown.map((suggestion, index) => {
              let SuggestionIcon = Slash;
              if (memberList || mentionQuery !== null) SuggestionIcon = AtSign;
              else if (suggestion.insert) SuggestionIcon = Zap;
              return (
                <button
                  key={suggestion.key}
                  role="option"
                  aria-selected={index === cursor}
                  data-team-mention={suggestion.mention}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    suggestion.pick();
                  }}
                  onMouseEnter={() => setCursor(index)}
                  className={cn("w-full flex items-center gap-2 h-7 px-2 rounded-md text-left text-sm", index === cursor ? "bg-surface-2 text-ink" : "text-ink-2")}
                >
                  <SuggestionIcon size={12} className="text-ink-4 shrink-0" />
                  {/* The label is the thing being inserted, so the hint gives way first. A
                    skill's description runs to a paragraph and would otherwise squeeze the
                    name it belongs to down to nothing. Half the row is the ceiling, so a
                    long file path still truncates rather than crowding out its own hint. */}
                  <span className={cn("truncate", suggestion.insert && "skill-token", suggestion.hint ? "shrink-0 max-w-1/2" : "min-w-0", mentionQuery !== null && "font-mono text-xs")}>
                    {suggestion.label}
                  </span>
                  {suggestion.hint ? <span className="ml-auto min-w-0 truncate text-xs text-ink-4">{suggestion.hint}</span> : null}
                </button>
              );
            })}
          </div>
          {hidden > 0 ? (
            <p role="status" className="composer-suggestions-more">
              {hidden} more. Keep typing to narrow.
            </p>
          ) : null}
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
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart);
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
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((current) => Math.min(shown.length - 1, current + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((current) => Math.max(0, current - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                shown[cursor]?.pick();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onChange(value.slice(0, memberQuery?.start ?? token?.start ?? 0) + value.slice(caret));
                return;
              }
            }
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
