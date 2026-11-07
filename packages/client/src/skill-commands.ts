import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentKind, AgentSkill, FileScope } from "@openorc/protocol";
import type { ClientQueries } from "./query.js";

/** What an agent takes before a skill's name in a message: Claude `/name`, Codex `$name`. */
export type SkillPrefix = "/" | "$";

/** A skill as a composer offers it, to put into the message. */
export interface SkillCommand {
  name: string;
  hint: string;
  insert: true;
  prefix: SkillPrefix;
  /** Other names it answers to, as a built-in may. */
  aliases?: string[];
}

/** Said in the picker while there are no skills to offer yet, when a word starts with the agent's prefix for them. */
export interface SkillListNotice {
  prefix: SkillPrefix;
  text: string;
  /** Why, when reading them failed. */
  reason?: string;
}

export interface SkillCommands {
  commands: SkillCommand[];
  /** Called as a `/` or `$` word starts, so a list read a while ago can be read again before it is used. */
  onCommandsWanted: () => void;
  commandsNotice: SkillListNotice | null;
}

/** The `/` or `$` word that ends at the caret: where it starts, its prefix, and what was typed after the prefix. */
export interface CommandWord {
  start: number;
  prefix: SkillPrefix;
  query: string;
}

/** A list this recent is used as it is when the picker opens. */
const FRESH_MS = 10_000;

/** Stands in while there is no scope; the read is disabled then, so it is never sent. */
const NO_SCOPE: FileScope = { kind: "project", id: "" };

/** What this project brought comes first: a personal or plugin skill reaches every project, so it says less about this one. */
const SOURCE_ORDER: Record<AgentSkill["source"], number> = { project: 0, user: 1, plugin: 2, system: 3 };

/** Reading a list with nothing yet clears its last error, so a read under way says so rather than nothing. */
function listNotice(prefix: SkillPrefix, reading: boolean, error: Error | null): SkillListNotice | null {
  if (reading) return { prefix, text: "Loading skills…" };
  return error ? { prefix, text: "Couldn’t load skills", reason: error.message } : null;
}

/**
 * The selected agent's skills where a conversation works, for any composer on any client. OpenCode loads skills
 * through its own tool, so it is offered none.
 *
 * Reading the list starts the agent's CLI, so it is read when a composer opens and again when the composer asks, as a
 * `/` or `$` word starts: a skill installed while a conversation is open shows up the next time the picker opens, not
 * on a timer.
 */
export function useSkillCommandsWith(queries: ClientQueries, scope: FileScope | null, selectedAgent: AgentKind | null | undefined, claudeAccountId: string | undefined): SkillCommands {
  const agent = selectedAgent === "acp" ? "opencode" : selectedAgent;
  const enabled = Boolean(scope && agent && agent !== "opencode");
  const skills = queries.useRpc(
    "skills.list",
    { ...(agent === "claude" && claudeAccountId ? { claudeAccountId } : {}), scope: scope ?? NO_SCOPE, agent: agent ?? "claude" },
    { enabled, staleTime: FRESH_MS },
  );
  const found = skills.data;
  const { dataUpdatedAt, isFetching, refetch } = skills;
  const prefix: SkillPrefix = agent === "codex" ? "$" : "/";
  // By the clock, not `isStale`: a list going stale renders nothing, so the flag can still say fresh.
  const onCommandsWanted = useCallback(() => {
    if (enabled && !isFetching && Date.now() - dataUpdatedAt > FRESH_MS) void refetch();
  }, [enabled, isFetching, dataUpdatedAt, refetch]);
  const commands = useMemo(
    () =>
      agent === "opencode"
        ? []
        : [...(found ?? [])]
            .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source])
            .map((skill) => ({ name: skill.name, hint: skill.description, insert: true as const, prefix, ...(skill.aliases?.length ? { aliases: skill.aliases } : {}) })),
    [agent, found, prefix],
  );
  // A list read before keeps being offered while it is read again, and when that fails.
  const commandsNotice = enabled && !found ? listNotice(prefix, isFetching, skills.error) : null;
  return { commands, onCommandsWanted, commandsNotice };
}

export function commandWordAt(text: string, caret: number): CommandWord | null {
  const word = /(?:^|\s)([/$][^\s]*)$/.exec(text.slice(0, caret))?.[1];
  return word ? { start: caret - word.length, prefix: word[0] as SkillPrefix, query: word.slice(1) } : null;
}

/**
 * A command word asks for the list again, once per word and even when the list is empty, since a skill installed since
 * it was read is what the picker should show. Only a new word asks: the callback changes as its read starts and ends,
 * and asking on that would loop on a failing read. Answers the notice the picker shows while there are no skills to
 * offer, when the word starts with their prefix.
 */
export function useCommandWord(word: CommandWord | null, onCommandsWanted: (() => void) | undefined, notice: SkillListNotice | null | undefined): SkillListNotice | null {
  const start = word?.start;
  const want = useRef(onCommandsWanted);
  want.current = onCommandsWanted;
  useEffect(() => {
    if (start !== undefined) want.current?.();
  }, [start]);
  return notice && word && word.prefix === notice.prefix ? notice : null;
}

/** How well a command answers what was typed: its name in full, its name's start, else an alias or the name after a plugin's colon. */
function matchRank(name: string, aliases: readonly string[], query: string): number | null {
  const typed = query.toLowerCase();
  const lower = name.toLowerCase();
  const others = aliases.map((alias) => alias.toLowerCase());
  if (lower === typed || others.includes(typed)) return 0;
  if (lower.startsWith(typed)) return 1;
  return [...others, ...lower.split(":").slice(1)].some((part) => part.startsWith(typed)) ? 2 : null;
}

/** The commands that answer what was typed, a name typed in full first, so a longer name or a plugin's never takes its place. */
export function rankCommands<T extends { name: string; aliases?: readonly string[] | undefined }>(commands: readonly T[], query: string): T[] {
  return commands
    .flatMap((command, index) => {
      const rank = matchRank(command.name, command.aliases ?? [], query);
      return rank === null ? [] : [{ command, rank, index }];
    })
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((match) => match.command);
}

/** The message with the skill in place of the word being typed and one space after it, the one already there or a new one, and the caret past that space. */
export function insertSkill(text: string, word: { start: number }, caret: number, skill: { prefix: SkillPrefix; name: string }): { text: string; caret: number } {
  const rest = text.slice(caret);
  const spaced = /^\s/.test(rest);
  const inserted = `${skill.prefix}${skill.name}${spaced ? "" : " "}`;
  return { text: `${text.slice(0, word.start)}${inserted}${rest}`, caret: word.start + inserted.length + (spaced ? 1 : 0) };
}

/** A run of the message, marked when it invokes a skill the agent will resolve. */
export interface SkillSegment {
  text: string;
  skill: boolean;
}

/**
 * The parts of a message that name a skill.
 *
 * Only a name the project actually has counts, so a stray slash, a path such as `/build/output`, or a command the app
 * owns stays plain. A skill token also has to start a word, because `http://x/formatting` contains one of these names
 * and means nothing by it. Plugin skills carry a colon, which is why the set is matched against rather than a
 * character class.
 */
export function skillSegments(text: string, names: ReadonlySet<string>, prefix: SkillPrefix = "/"): SkillSegment[] {
  if (names.size === 0 || text === "") return text === "" ? [] : [{ text, skill: false }];
  // Longest first, so `/figma:figma-use` is not cut short by a `/figma` that also exists. Escaped because a skill name
  // is a directory name, not a pattern.
  const alternatives = [...names].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const marker = prefix === "$" ? "\\$" : "/";
  const pattern = new RegExp(`(^|\\s)(${marker}(?:${alternatives.join("|")}))(?![\\w:/-])`, "g");
  const segments: SkillSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + (match[1] ?? "").length;
    if (start > at) segments.push({ text: text.slice(at, start), skill: false });
    segments.push({ text: match[2] ?? "", skill: true });
    at = start + (match[2] ?? "").length;
  }
  if (at < text.length) segments.push({ text: text.slice(at), skill: false });
  return segments;
}

/** Every name a message may use for the skills offered: each name, and each other name it answers to. */
export function skillNames(commands: readonly { name: string; insert?: boolean; aliases?: readonly string[] | undefined }[]): Set<string> {
  return new Set(commands.flatMap((command) => (command.insert ? [command.name, ...(command.aliases ?? [])] : [])));
}
