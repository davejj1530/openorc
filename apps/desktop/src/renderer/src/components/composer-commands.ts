import { insertSkill, rankCommands } from "@openorc/client";
import type { UsableConnector } from "@openorc/protocol";
import { useEffect, useRef } from "react";
import { insertMention } from "../lib/composer-mentions";
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
  /** A connector's image, drawn before its name. */
  logo?: { title: string; logo: string | null };
  /** The heading over the run of rows this one starts or continues. */
  group?: string;
  /** Why the row is listed but cannot be picked, said over its run and on hover. */
  unavailable?: string;
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
    ...(command.icon ? { logo: { title: command.displayName ?? command.name, logo: command.icon } } : {}),
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

/** Connectors whose name, or what people call them, starts with the `@` word, case-insensitive. */
export function matchingConnectors(connectors: UsableConnector[] | undefined, query: string | null): UsableConnector[] {
  if (query === null) return [];
  const needle = query.toLowerCase();
  return (connectors ?? []).filter((connector) => [connector.name, connector.title].some((name) => name.toLowerCase().startsWith(needle)));
}

/** The rows for the connectors that match: picking one puts `@name ` in place of the word. */
export function connectorRows(matches: UsableConnector[], { token, caret, value, onChange, placeCaret }: Omit<Draft, "query">): SuggestionRow[] {
  return matches.map((connector) => ({
    key: `connector:${connector.name}`,
    label: `@${connector.name}`,
    ...(connector.title !== connector.name ? { hint: connector.title } : {}),
    logo: { title: connector.title, logo: connector.logo },
    pick: () => {
      if (!token) return;
      const next = insertMention(value, token.start, caret, connector.name);
      onChange(next.text);
      placeCaret(next.caret);
    },
  }));
}

/**
 * What `@` lists: the connectors the agent has, then the ones it goes without in this mode, dimmed under why, then the
 * files whose path matches, each run under its heading.
 */
export function mentionRows(
  { usable, aside, files }: { usable: UsableConnector[]; aside: { connectors: UsableConnector[]; reason: string } | null; files: string[] },
  draft: Omit<Draft, "query">,
): SuggestionRow[] {
  const reason = aside?.reason ?? "";
  return [
    ...connectorRows(usable, draft).map((row) => ({ ...row, group: "Connectors" })),
    ...connectorRows(aside?.connectors ?? [], draft).map((row) => ({ ...row, group: reason, unavailable: reason, pick: () => {} })),
    ...fileRows(files, draft).map((row) => ({ ...row, group: "Files" })),
  ];
}

/** The first row the list can pick, past any dimmed connectors heading it. */
export const firstPickable = (rows: readonly SuggestionRow[]): number =>
  Math.max(
    0,
    rows.findIndex((row) => !row.unavailable),
  );

/** Where an arrow key moves the cursor: to the next row that can be picked, staying put at either end. */
export function nextPickable(rows: readonly SuggestionRow[], from: number, step: 1 | -1): number {
  for (let at = from + step; at >= 0 && at < rows.length; at += step) if (!rows[at]?.unavailable) return at;
  return from;
}

/** The connectors the agent goes without in this mode whose names match the `@` word, still with why. */
export function asideMatching(aside: { connectors: UsableConnector[]; reason: string } | undefined, query: string | null): { connectors: UsableConnector[]; reason: string } | null {
  return aside ? { ...aside, connectors: matchingConnectors(aside.connectors, query) } : null;
}

/** The rows for files whose path matches the `@` word: picking one puts the path in its place. */
export function fileRows(paths: string[], { token, caret, value, onChange, placeCaret }: Omit<Draft, "query">): SuggestionRow[] {
  return paths.map((filePath) => ({
    key: filePath,
    label: filePath,
    pick: () => {
      if (!token) return;
      onChange(`${value.slice(0, token.start)}${filePath} ${value.slice(caret)}`);
      placeCaret(token.start + filePath.length + 1);
    },
  }));
}

/** Asks for the connector list once per `@` word, as the skill list is asked for once per `/` word. */
export function useConnectorWord(token: { start: number } | null, atQuery: string | null, onConnectorsWanted: (() => void) | undefined): void {
  const start = atQuery !== null ? token?.start : undefined;
  const want = useRef(onConnectorsWanted);
  want.current = onConnectorsWanted;
  useEffect(() => {
    if (start !== undefined) want.current?.();
  }, [start]);
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
  // A dimmed connector can't be picked: Tab and Enter keep their own meaning on it.
  if (row.unavailable && (press.key === "Tab" || press.key === "Enter")) return "pass";
  const plain = ROW_KEYS[press.key];
  if (plain) return plain;
  if (!plainEnter(press)) return "pass";
  return row.insert === true && (row.complete === true || (!chosen && endsMessage)) ? "send" : "pick";
}

/** Enter with no modifier, the one that picks or sends. */
const plainEnter = (press: KeyPress) => press.key === "Enter" && !press.shiftKey && !press.metaKey && !press.ctrlKey && !press.altKey;
