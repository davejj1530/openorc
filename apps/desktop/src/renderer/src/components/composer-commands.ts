import { useEffect, useRef } from "react";
import type { CommandsNotice, SlashCommand } from "./Composer";

/** One row of the composer's suggestions: a mention, a file, a skill or an app action. */
export interface SuggestionRow {
  key: string;
  label: string;
  hint?: string;
  mention?: string;
  insert?: boolean;
  /** A skill typed in full, by its name or one it also answers to: there is nothing to put in its place. */
  complete?: boolean;
  pick: () => void;
}

/** How well a command answers what was typed: its name in full, its name's start, else an alias or the name after a plugin's colon. */
function matchRank(command: SlashCommand, query: string): number | null {
  const typed = query.toLowerCase();
  const name = command.name.toLowerCase();
  const aliases = (command.insert ? (command.aliases ?? []) : []).map((alias) => alias.toLowerCase());
  if (name === typed || aliases.includes(typed)) return 0;
  if (name.startsWith(typed)) return 1;
  return [...aliases, ...name.split(":").slice(1)].some((part) => part.startsWith(typed)) ? 2 : null;
}

export function matchingCommands(commands: SlashCommand[] | undefined, query: string | null, prefix: string | undefined, start: number | undefined): SlashCommand[] {
  if (query === null) return [];
  // Slash opens the skill picker for either harness; selection still inserts its native prefix.
  const offered = (commands ?? []).filter((command) => (command.insert ? prefix === "/" || command.prefix === prefix : prefix === "/" && start === 0));
  // A name typed in full comes first, so a longer name or a plugin's of the same name never takes its place.
  return offered
    .flatMap((command, index) => {
      const rank = matchRank(command, query);
      return rank === null ? [] : [{ command, rank, index }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((match) => match.command);
}

interface Draft {
  query: string | null;
  token: { start: number } | null;
  caret: number;
  value: string;
  onChange: (text: string) => void;
  placeCaret: (at: number) => void;
}

/** The rows for the commands that match: a skill goes into the message, an app action runs. */
export function commandRows(matches: SlashCommand[], { query, token, caret, value, onChange, placeCaret }: Draft): SuggestionRow[] {
  return matches.map((command) => ({
    // A project may have a command named like one of the app's own actions, and both are offered.
    key: `${command.insert ? `skill:${command.prefix}` : "action:/"}${command.name}`,
    label: `${command.insert ? command.prefix : "/"}${command.name}`,
    hint: command.hint,
    insert: command.insert === true,
    complete: command.insert === true && query !== null && (command.name === query || (command.aliases ?? []).includes(query)),
    pick: () => {
      const rest = value.slice(caret);
      if (command.insert) {
        // Preserve the harness's invocation prefix when inserting the skill.
        if (!token) return;
        // One space after the name: the one already there, or a new one. The caret goes past it either way.
        const spaced = /^\s/.test(rest);
        const text = `${command.prefix}${command.name}${spaced ? "" : " "}`;
        onChange(`${value.slice(0, token.start)}${text}${rest}`);
        placeCaret(token.start + text.length + (spaced ? 1 : 0));
        return;
      }
      // An action starts the message, and what was written after it stays for the next one.
      onChange(rest.replace(/^\s+/, ""));
      command.run();
    },
  }));
}

/** What a key does while the suggestions are open. `send` closes them and lets Enter send. */
export type SuggestionKey = "down" | "up" | "pick" | "close" | "send" | "pass";

interface KeyPress {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

/** Keys that mean the same on every row. */
const ROW_KEYS: Partial<Record<string, SuggestionKey>> = { ArrowDown: "down", ArrowUp: "up", Tab: "pick" };

/**
 * Tab picks the selected row and Enter does too, with exceptions where Enter keeps its own meaning: with Shift, Cmd or
 * Ctrl; on a skill typed in full; and on a slash word that ends a message after other words, such as a path, unless the
 * arrow keys chose the row. Esc only closes the list, and Enter during IME composition belongs to the input method.
 */
export function suggestionKey(press: KeyPress, row: SuggestionRow | undefined, { chosen, endsMessage }: { chosen: boolean; endsMessage: boolean }): SuggestionKey {
  if (press.isComposing) return "pass";
  if (press.key === "Escape") return "close";
  // A notice alone has no row to move to or pick: the message keeps its keys.
  if (!row) return "pass";
  const plain = ROW_KEYS[press.key];
  if (plain) return plain;
  if (press.key !== "Enter" || press.shiftKey || press.metaKey || press.ctrlKey || press.altKey) return "pass";
  return row?.insert === true && (row.complete === true || (!chosen && endsMessage)) ? "send" : "pick";
}

/**
 * A `/` or `$` word at the caret asks for the command list again, once per word and even when the list is empty, since
 * a skill installed since it was read is what the picker should show. Only a new word asks: the callback changes as its
 * read starts and ends, and asking on that would loop on a failing read. Answers the notice the picker shows while there
 * are no skills to offer, when the word starts with their prefix.
 */
export function useCommandWord(token: { start: number; token: string } | null, onCommandsWanted: (() => void) | undefined, unavailable: CommandsNotice | null | undefined): CommandsNotice | null {
  const prefix = token?.token[0];
  const start = prefix === "/" || prefix === "$" ? token?.start : undefined;
  const want = useRef(onCommandsWanted);
  want.current = onCommandsWanted;
  useEffect(() => {
    if (start !== undefined) want.current?.();
  }, [start]);
  return unavailable && start !== undefined && prefix === unavailable.prefix ? unavailable : null;
}
