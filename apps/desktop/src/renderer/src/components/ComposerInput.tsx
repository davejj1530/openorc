import { askKeyAct, askKeyName, commandWordAt, useCommandWord, type AskPlace, type SkillListNotice } from "@openorc/client";
import type { FileScope, UsableConnector } from "@openorc/protocol";
import { Fragment, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref, type RefObject } from "react";
import { useRpc } from "../lib/client";
import { filterMentions, mentionQueryAt, usePickedFiles, type MentionEntry } from "../lib/composer-mentions";
import { insertReference } from "../lib/file-drag";
import type { SlashCommand } from "./Composer";
import {
  asideMatching,
  firstPickable,
  LIST_STARTS,
  matchingCommands,
  matchingConnectors,
  memberRows,
  mentionRows,
  ofKind,
  suggestionKey,
  useConnectorWord,
  type ListKind,
  type SuggestionRow,
} from "./composer-commands";
import { ComposerSuggestions } from "./ComposerSuggestions";
import { useHostedControlReason } from "./HostedConversationBoundary";
import { blockHostedCommandKey, cloudCommandRows, holdsRows, hostedFileSuggestion, nextCommandSuggestion, useHeldCommands } from "./HostedComposerControls";
import { TipAt } from "./TipLayer";
import { ComposerSuggestionOption } from "./ComposerSuggestionOption";
import { peopleRows, usePeopleMatches } from "./composer-people";
import type { PeoplePicks } from "./composer-notes";
import { ComposerEditor, type ComposerEditorHandle, type DraftChange } from "./composer-editor/ComposerEditor";
import { SkillHoverCard, useSkillHover } from "./MarkedText";

interface ComposerInputProps {
  value: string;
  onChange: (text: string) => void;
  /** Enter sends its way; `otherWay` when Command or Control is held, which takes the other of send now and queue. */
  onSubmit: (otherWay: boolean) => void;
  onFiles: (files: File[]) => Promise<void>;
  onReady?: ((why?: "focus" | "words", message?: string) => void) | undefined;
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
  /** The editor's handle, which the composer holds too, to write a queued message back. */
  editor: RefObject<ComposerEditorHandle | null>;
  /** What the plus menu opens: one kind's list, at the caret. */
  lists?: Ref<ComposerLists> | undefined;
  /** An ask docked onto the composer, which arrow up or Shift and Tab enter at its question. */
  ask?: { enter: () => void } | null | undefined;
  /** Who `@` may tag, in a thread with notes. */
  people?: PeoplePicks | undefined;
  /** What the composer around it can do to the prompt. */
  handle?: Ref<ComposerInputHandle>;
}

export interface ComposerInputHandle {
  /** False while the prompt can't be written in, as while a message sends. */
  writable: boolean;
  /** Put a reference, such as a file's path, where the caret last was, a word of its own, and the caret after it. */
  insert: (reference: string) => void;
}

/** Opens the list of one kind at the caret, as typing `@` or `/` there would, showing only that kind. */
export interface ComposerLists {
  open: (kind: ListKind) => void;
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

/**
 * The kind the plus menu opened a list of, for as long as the word it began is the one at the caret, and the opener the
 * plus calls.
 */
function useListKind(
  lists: Ref<ComposerLists> | undefined,
  { token, caret, value, editor, onOpen }: { token: { start: number } | null; caret: number; value: string; editor: RefObject<ComposerEditorHandle | null>; onOpen: () => void },
): ListKind | null {
  const [kind, setKind] = useState<{ kind: ListKind; start: number } | null>(null);
  useImperativeHandle(
    lists,
    () => ({
      open: (opened) => {
        setKind({ kind: opened, start: caret + (caret > 0 && !/\s$/.test(value.slice(0, caret)) ? 1 : 0) });
        onOpen();
        editor.current?.begin(LIST_STARTS[opened], caret);
      },
    }),
    [value, caret, editor, onOpen],
  );
  return kind && token?.start === kind.start ? kind.kind : null;
}

/** A key the docked ask's table takes from the field: into the ask at its question, or nothing at all. */
function askTook(event: KeyboardEvent, ask: ComposerInputProps["ask"], field: { listOpen: boolean; value: string }): boolean {
  let place: AskPlace = field.value ? "fieldText" : "fieldEmpty";
  if (field.listOpen) place = "fieldList";
  const key = ask ? askKeyName(event) : null;
  const act = key ? askKeyAct(place, key, true) : "pass";
  if (act !== "enter" && act !== "none") return false;
  event.preventDefault();
  if (act === "enter") ask?.enter();
  return true;
}

/** Owns text interaction: suggestions, the caret and focus, around the editor that holds the words. */
export function ComposerInput(props: ComposerInputProps) {
  const { value, onChange, onSubmit, onFiles, disabled, placeholder, autoFocus, mentions, commands, onCommandsWanted, connectors, onConnectorsWanted } = props;
  const fileReason = useHostedControlReason("fileBrowser");
  const { compact: heldCompact, fork: heldFork } = useHeldCommands();
  const held = useMemo(() => ({ compact: heldCompact, fork: heldFork }), [heldCompact, heldFork]);
  const fileSearch = fileReason ? undefined : props.fileSearch;
  // A restored draft is picked up at its end, as typing or a dropped file there would expect.
  const [caret, setCaret] = useState(() => value.length);
  const [cursor, setCursor] = useState(0);
  const [suggestionsActive, setSuggestionsActive] = useState(true);
  const { editor } = props;
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const picked = usePickedFiles(props.draftKey, value);
  const named = props.people?.named;
  const sources = useMemo(() => ({ commands, connectors, members: mentions, files: picked.files, people: named }), [commands, connectors, mentions, picked.files, named]);
  const token = useMemo(() => tokenAtCaret(value, caret), [value, caret]);
  const scope = useListKind(props.lists, { token, caret, value, editor, onOpen: () => setSuggestionsActive(true) });
  useImperativeHandle(
    props.handle,
    () => ({
      writable: !disabled,
      insert: (reference: string) => {
        const next = insertReference(value, caret, reference);
        editor.current?.write(next.text, next.caret);
        setCaret(next.caret);
        editor.current?.focus();
      },
    }),
    [disabled, value, caret, editor],
  );
  const memberQuery = useMemo(() => (mentions?.length && (scope === null || scope === "orcling") ? mentionQueryAt(value, caret) : null), [mentions, value, caret, scope]);
  const memberMatches = useMemo(() => (memberQuery ? filterMentions(mentions ?? [], memberQuery.query) : []), [memberQuery, mentions]);
  const atQuery = token?.token.startsWith("@") ? token.token.slice(1) : null;
  const mentionQuery = fileSearch ? atQuery : null;
  const connectorMatches = useMemo(() => matchingConnectors(connectors, atQuery), [connectors, atQuery]);
  const personMatches = usePeopleMatches(props.people, atQuery);
  const asideMatches = useMemo(() => asideMatching(props.connectorsAside, atQuery), [props.connectorsAside, atQuery]);
  useConnectorWord(token, atQuery, onConnectorsWanted);
  const commandPrefix = token?.token[0];
  const commandQuery = commandQueryAt(token, commands);
  const notice = useCommandWord(commandWordAt(value, caret), onCommandsWanted, props.commandsNotice) ?? connectorsNotice(atQuery, props.connectorsLoading);
  const files = useRpc("files.search", { scope: fileSearch ?? NO_SEARCH, query: mentionQuery ?? "", limit: 8 }, { enabled: mentionQuery !== null, staleTime: 10_000 });
  // Skills insert into the prompt; actions clear it, so only offer actions at the start.
  const commandMatches = useMemo(() => matchingCommands(commands, commandQuery, commandPrefix, token?.start), [commandPrefix, commandQuery, commands, token?.start]);
  const write = useCallback((text: string, at: number) => editor.current?.pick(text, at), [editor]);
  const all: SuggestionRow[] = useMemo(() => {
    const members = memberQuery ? memberRows(memberMatches, { start: memberQuery.start, caret, value, write }) : [];
    if (atQuery !== null) {
      const draft = { token, caret, value, write, onFile: picked.pick };
      return [
        ...members,
        ...peopleRows(personMatches, props.people, draft),
        ...mentionRows({ usable: connectorMatches, aside: asideMatches, files: mentionQuery !== null ? (files.data ?? []) : [] }, draft),
        ...hostedFileSuggestion(fileReason),
      ];
    }
    if (members.length) return members;
    return cloudCommandRows(held, commandMatches, { query: commandQuery, token, caret, value, write }, token);
  }, [
    memberQuery,
    memberMatches,
    atQuery,
    personMatches,
    props.people,
    connectorMatches,
    asideMatches,
    mentionQuery,
    files.data,
    commandMatches,
    commandQuery,
    token,
    caret,
    value,
    write,
    picked.pick,
    fileReason,
    held,
  ]);
  const suggestions = useMemo(() => (scope ? all.filter((row) => ofKind(row, scope)) : all), [all, scope]);
  // The skill under the pointer says what it is for.
  const skillHover = useSkillHover(root);
  // Whether the arrow keys chose the row, which is what lets Enter pick one in the middle of a message.
  const [chosen, setChosen] = useState(false);
  // Whether the row under the cursor is the keys' and not the pointer's: only then does a disabled one say why itself.
  const [keyed, setKeyed] = useState(false);
  // The list as it now stands, for the reset below, which runs only when a new list opens.
  const rows = useRef(suggestions);
  rows.current = suggestions;
  useEffect(() => {
    setCursor(firstPickable(rows.current));
    setChosen(false);
    setKeyed(false);
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
                <ComposerSuggestionOption
                  row={suggestion}
                  id={`${listId}-${index}`}
                  selected={index === cursor}
                  onPoint={() => {
                    setCursor(index);
                    setKeyed(false);
                  }}
                />
              </Fragment>
            ))}
          </div>
          <ChosenRowReason id={`${listId}-${cursor}`} row={suggestions[cursor]} keyed={keyed} />
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
          if (blockHostedCommandKey(held, value, e)) {
            setChosen(true);
            setKeyed(true);
            return true;
          }
          if (askTook(e, props.ask, { listOpen: suggestionsOpen, value })) return true;
          const endsMessage = (token?.start ?? 0) > 0 && value.slice(caret).trim() === "";
          const action = suggestionsOpen ? suggestionKey(e, suggestions[cursor], { chosen, endsMessage }) : "pass";
          if (action === "down" || action === "up") {
            e.preventDefault();
            setChosen(true);
            setKeyed(true);
            setCursor((current) => nextCommandSuggestion(holdsRows(held, fileReason), suggestions, current, action === "down" ? 1 : -1));
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

/**
 * Why a disabled row the arrow keys chose can't be picked, in the window's tip. The message keeps the focus while the
 * keys move through the list, so neither hover nor focus opens the row's own tip; the pointer's rows open theirs.
 */
function ChosenRowReason({ id, row, keyed }: { id: string; row: SuggestionRow | undefined; keyed: boolean }) {
  const reason = keyed ? row?.unavailable : undefined;
  const [anchor, setAnchor] = useState<Element | null>(null);
  useLayoutEffect(() => setAnchor(reason ? document.getElementById(id) : null), [id, reason]);
  return <TipAt open={Boolean(anchor && reason)} anchor={anchor} label={reason} />;
}
