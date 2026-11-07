import { insertSkill, rankCommands } from "@openorc/client";
import type { SlashCommand } from "./Composer";

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

export function matchingCommands(commands: SlashCommand[] | undefined, query: string | null, prefix: string | undefined, start: number | undefined): SlashCommand[] {
  if (query === null) return [];
  // Slash opens the skill picker for either harness; selection still inserts its native prefix.
  const offered = (commands ?? []).filter((command) => (command.insert ? prefix === "/" || command.prefix === prefix : prefix === "/" && start === 0));
  return rankCommands(offered, query);
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
        if (!token) return;
        const next = insertSkill(value, token, caret, command);
        onChange(next.text);
        placeCaret(next.caret);
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
