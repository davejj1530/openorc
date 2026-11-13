import { commandWordAt, useCommandWord, type SkillListNotice } from "@openorc/client";
import type { FileScope, UsableConnector } from "@openorc/protocol";
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { filterMentions, insertMention, mentionQueryAt, usePickedFiles, type MentionEntry } from "../lib/composer-mentions";
import type { SlashCommand } from "./Composer";
import { asideMatching, commandRows, firstPickable, matchingCommands, matchingConnectors, mentionRows, nextPickable, suggestionKey, useConnectorWord, type SuggestionRow } from "./composer-commands";
import { ComposerSuggestions } from "./ComposerSuggestions";
import { ConnectorLogo } from "./ConnectorLogo";
import { ComposerEditor, type ComposerEditorHandle, type DraftChange } from "./composer-editor/ComposerEditor";
import { SkillHoverCard, useSkillHover } from "./MarkedText";

interface ComposerInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Enter sends its way; `otherWay` when Command or Control is held, which takes the other of send now and queue. */
  onSubmit: (otherWay: boolean) => void;
  onFiles: (files: File[]) => Promise<void>;
  onReady?: (() => void) | undefined;
  /** Where the draft's picked files are kept beside its attachments. */
  draftKey?: string | undefined;
  disabled: boolean;
  placeholder: string;
  autoFocus?: boolean;
  fileSearch?: FileScope;
  mentions?: MentionEntry[];
  commands?: SlashCommand[];
  onCommandsWanted?: () => void;
  commandsNotice?: SkillListNotice | null;
  connectors?: UsableConnector[];
  connectorsAside?: { connectors: UsableConnector[]; reason: string } | undefined;
  connectorsLoading?: boolean | undefined;
  onConnectorsWanted?: () => void;
  suggestionAnchor: RefObject<HTMLDivElement | null>;
  suggestionSide: "top" | "bottom";
}

/** What `@` says while the connector list is read for the first time, which starts the agents' servers. */
function connectorsNotice(atQuery: string | null, loading: boolean | undefined): Pick<SkillListNotice, "text" | "reason"> | null {
  return atQuery !== null && loading ? { text: "Loading connectors…" } : null;
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

function suggestionLabel(members: boolean, mention: boolean): string {
  if (members) return "Mention an Orcling";
  if (mention) return "Mention a connector or file";
  return "Commands";
}

/** Owns text interaction: suggestions, the caret and focus, around the editor that holds the words. */
export function ComposerInput(props: ComposerInputProps) {
  const { value, onChange, onSubmit, onFiles, disabled, placeholder, autoFocus, fileSearch, mentions, commands, onCommandsWanted, connectors, onConnectorsWanted } = props;
  const [caret, setCaret] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [suggestionsActive, setSuggestionsActive] = useState(true);
  const editor = useRef<ComposerEditorHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const picked = usePickedFiles(props.draftKey, value);
  const sources = useMemo(() => ({ commands, connectors, members: mentions, files: picked.files }), [commands, connectors, mentions, picked.files]);
  const token = useMemo(() => tokenAtCaret(value, caret), [value, caret]);
  const memberQuery = useMemo(() => (mentions?.length ? mentionQueryAt(value, caret) : null), [mentions, value, caret]);
  const memberMatches = useMemo(() => (memberQuery ? filterMentions(mentions ?? [], memberQuery.query) : []), [memberQuery, mentions]);
  const atQuery = token?.token.startsWith("@") && !memberMatches.length ? token.token.slice(1) : null;
  const mentionQuery = fileSearch ? atQuery : null;
  const connectorMatches = useMemo(() => matchingConnectors(connectors, atQuery), [connectors, atQuery]);
  const asideMatches = useMemo(() => asideMatching(props.connectorsAside, atQuery), [props.connectorsAside, atQuery]);
  useConnectorWord(token, atQuery, onConnectorsWanted);
  const commandPrefix = token?.token[0];
  const commandQuery = commandQueryAt(token, commands);
  const notice = useCommandWord(commandWordAt(value, caret), onCommandsWanted, props.commandsNotice) ?? connectorsNotice(atQuery, props.connectorsLoading);
  const files = useRpc("files.search", { scope: fileSearch ?? NO_SEARCH, query: mentionQuery ?? "", limit: 8 }, { enabled: mentionQuery !== null, staleTime: 10_000 });
  // Skills insert into the prompt; actions clear it, so only offer actions at the start.
  const commandMatches = useMemo(() => matchingCommands(commands, commandQuery, commandPrefix, token?.start), [commandPrefix, commandQuery, commands, token?.start]);
  const write = useCallback((text: string, at: number) => editor.current?.write(text, at), []);
  const suggestions: SuggestionRow[] = useMemo(() => {
    if (memberQuery && memberMatches.length) {
      return memberMatches.map((entry) => ({
        key: `mention:${entry.key}`,
        label: `@${entry.name}`,
        hint: entry.hint,
        mention: entry.key,
        pick: () => {
          const next = insertMention(value, memberQuery.start, caret, entry.name);
          write(next.text, next.caret);
        },
      }));
    }
    if (atQuery !== null) {
      const draft = { token, caret, value, write, onFile: picked.pick };
      return mentionRows({ usable: connectorMatches, aside: asideMatches, files: mentionQuery !== null ? (files.data ?? []) : [] }, draft);
    }
    return commandRows(commandMatches, { query: commandQuery, token, caret, value, write });
  }, [memberQuery, memberMatches, atQuery, connectorMatches, asideMatches, mentionQuery, files.data, commandMatches, commandQuery, token, caret, value, write, picked.pick]);
  // The skill under the pointer says what it is for.
  const skillHover = useSkillHover(root);
  // Whether the arrow keys chose the row, which is what lets Enter pick one in the middle of a message.
  const [chosen, setChosen] = useState(false);
  // The list as it now stands, for the reset below, which runs only when a new list opens.
  const rows = useRef(suggestions);
  rows.current = suggestions;
  useEffect(() => {
    setCursor(firstPickable(rows.current));
    setChosen(false);
  }, [suggestions.length, memberQuery?.query, atQuery, commandQuery]);
  const memberList = suggestions.length > 0 && Boolean(suggestions[0]?.mention);
  const listOpen = suggestionsActive && suggestions.length > 0;
  const suggestionsOpen = listOpen || (suggestionsActive && notice !== null);
  // Focus stays in the message while the arrows move through the list, so a screen reader follows the row this names.
  const listAria = listOpen ? { "aria-controls": listId, "aria-activedescendant": `${listId}-${cursor}` } : {};

  return (
    <>
      {suggestionsOpen ? (
        <ComposerSuggestions anchor={props.suggestionAnchor} side={props.suggestionSide} members={memberList} cursor={cursor} count={suggestions.length} onDismiss={() => setSuggestionsActive(false)}>
          {/* First, where the rows it waits for will land: connectors head the list, above the files that match. */}
          {notice ? (
            <div role="status" data-tip={notice.reason} className="composer-suggestions-notice">
              {notice.text}
            </div>
          ) : null}
          <div id={listId} role="listbox" hidden={suggestions.length === 0} aria-label={suggestionLabel(memberList, atQuery !== null)} data-agent-mention-list={memberList || undefined}>
            {suggestions.map((suggestion, index) => (
              <Fragment key={suggestion.key}>
                {suggestion.group && suggestion.group !== suggestions[index - 1]?.group ? (
                  <div aria-hidden="true" className="composer-suggestion-group">
                    {suggestion.group}
                  </div>
                ) : null}
                <button
                  id={`${listId}-${index}`}
                  tabIndex={-1}
                  role="option"
                  aria-selected={index === cursor}
                  aria-disabled={suggestion.unavailable ? true : undefined}
                  data-tip={suggestion.unavailable}
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
                  <span className={cn("composer-suggestion-label", (suggestion.insert || suggestion.logo) && "skill-token")} data-mono={memberList ? undefined : true}>
                    {suggestion.logo ? <ConnectorLogo title={suggestion.logo.title} logo={suggestion.logo.logo} size={16} /> : null}
                    {suggestion.label}
                  </span>
                  {suggestion.hint ? <span className="composer-suggestion-hint">{suggestion.hint}</span> : null}
                </button>
              </Fragment>
            ))}
          </div>
        </ComposerSuggestions>
      ) : null}
      <SkillHoverCard mark={skillHover.hovered} commands={commands} />
      <ComposerEditor
        handle={editor}
        rootRef={root}
        value={value}
        onChange={({ text, caret: at, edited }: DraftChange) => {
          if (at !== null) setCaret(at);
          if (!edited) return;
          onChange(text);
          setSuggestionsActive(true);
        }}
        sources={sources}
        onKeyDown={(e) => {
          const endsMessage = (token?.start ?? 0) > 0 && value.slice(caret).trim() === "";
          const action = suggestionsOpen ? suggestionKey(e, suggestions[cursor], { chosen, endsMessage }) : "pass";
          if (action === "down" || action === "up") {
            e.preventDefault();
            setChosen(true);
            setCursor((current) => nextPickable(suggestions, current, action === "down" ? 1 : -1));
            return true;
          }
          if (action === "pick" || action === "close") {
            e.preventDefault();
            if (action === "pick") suggestions[cursor]?.pick();
            else setSuggestionsActive(false);
            return true;
          }
          if (action === "send") setSuggestionsActive(false);
          if (e.key !== "Enter" || e.shiftKey) return false;
          e.preventDefault();
          onSubmit(e.metaKey || e.ctrlKey);
          return true;
        }}
        onFiles={(dropped) => void onFiles(dropped)}
        onReady={props.onReady}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        completion={listAria}
        onFocus={() => setSuggestionsActive(true)}
        onBlur={() => setSuggestionsActive(false)}
        onPointerMove={skillHover.onPointerMove}
        onPointerLeave={skillHover.onPointerLeave}
      />
    </>
  );
}
