import type { AgentKind } from "./events.js";

/**
 * A word that may call a skill: `/name`, `$name` or `/skill:name`, with any punctuation that ends a sentence after it.
 * Only a name the button calls counts, so a path such as `/src/app` stays a path.
 */
const SKILL_WORD = /(^|\s)([/$]\S+?)([.,;:!?)]*)(?=\s|$)/g;

/** The skill a word calls, when it is one of `names`. `/skill:name` is Pi's way to call `name`. */
function calledSkill(word: string, names: ReadonlySet<string>): string | null {
  const piName = word.startsWith("/skill:") ? word.slice("/skill:".length) : "";
  if (piName && names.has(piName)) return piName;
  return names.has(word.slice(1)) ? word.slice(1) : null;
}

/** Where a call sits: first in the prompt, with punctuation after it, and with nothing else after it. */
type CallPlace = { first: boolean; punctuated: boolean; last: boolean };

function rewriteSkillCalls(prompt: string, names: ReadonlySet<string>, write: (name: string, place: CallPlace) => string): string {
  return prompt.replace(SKILL_WORD, (match, space: string, word: string, after: string, offset: number) => {
    const name = calledSkill(word, names);
    if (name === null) return match;
    const place = { first: offset === 0, punctuated: after !== "", last: !prompt.slice(offset + match.length).trim() };
    return `${space}${write(name, place)}${after}`;
  });
}

/**
 * What a message types before a skill's name to call it. OpenCode, and agents reached through ACP, load skills through
 * a tool of their own, so they have no call and are asked for the skill by name.
 */
const SKILL_CALL_PREFIX: Record<AgentKind, string | null> = {
  codex: "$",
  fx: "$",
  pi: "/skill:",
  omp: "/skill:",
  opencode: null,
  acp: null,
  claude: "/",
  cursor: "/",
  antigravity: "/",
};

export const skillCallPrefix = (agent: AgentKind): string | null => SKILL_CALL_PREFIX[agent];

export function skillCall(name: string, agent: AgentKind): string | null {
  const prefix = skillCallPrefix(agent);
  return prefix === null ? null : `${prefix}${name}`;
}

/** A skill asked for by name, for an agent with no call: a sentence of its own where the prompt starts with it. */
function askForSkill(name: string, { first, punctuated, last }: CallPlace): string {
  if (!first) return `the ${name} skill`;
  if (punctuated) return `Use the ${name} skill`;
  return `Use the ${name} skill${last ? "." : ":"}`;
}

/**
 * A task button's prompt as the agent running it takes it. The button saves its calls as `/name`, with the names of
 * the skills it calls in `skills`; each call of one of those is written the agent's way.
 */
export function skillPrompt(prompt: string, skills: readonly string[] | undefined, agent: AgentKind): string {
  if (!skills?.length) return prompt;
  return rewriteSkillCalls(prompt, new Set(skills), (name, place) => skillCall(name, agent) ?? askForSkill(name, place));
}

/**
 * A task button's prompt as it is saved: each call of a `known` skill, in any agent's form, written `/name`, and the
 * skills it calls, in the order it first calls them.
 */
export function savedSkillPrompt(prompt: string, known: Iterable<string>): { prompt: string; skills: string[] } {
  const called = new Set<string>();
  const saved = rewriteSkillCalls(prompt, new Set(known), (name) => {
    called.add(name);
    return `/${name}`;
  });
  return { prompt: saved, skills: [...called] };
}
