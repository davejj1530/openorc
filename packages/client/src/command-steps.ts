import { readCommand, shortPath, type CommandAction } from "./command-reader.js";
import { basename } from "./run-labels.js";
import { pipeline, shellTokens } from "./shell.js";

/**
 * One step of a command read for a person: what it does in plain words, and where the part that only trims what it
 * prints (`2>&1 | tail -3`) begins, so the step can lead with its words and let that part step back.
 */
export interface StepReading {
  /** "Run the tests", "Read manager.ts", or null for a command people would not know. */
  label: string | null;
  /** What it worked on, beside the label: a test file, the lines read, a search's scope. */
  detail: string | null;
  /** Where the plumbing begins in the step's text, or null when it has none. */
  plumbing: number | null;
}

/** Commands that only cut down what the command before them printed. */
const TRIMMERS = /^(head|tail|grep|egrep|rg|sed|cut|sort|uniq|tr|cat|less|more|column)$/;
/** Redirections that only merge or silence what it prints. */
const QUIET = /\s+(?:\d?>&\d|&>\s*\/dev\/null|\d?>\s*\/dev\/null)(?:\s+(?:\d?>&\d|\d?>\s*\/dev\/null))*\s*$/;

function words(action: CommandAction): { label: string; detail: string | null } | null {
  switch (action.type) {
    case "read":
      return { label: `Read ${basename(action.path)}`, detail: action.range };
    case "search":
      return { label: `Search ${action.query}`, detail: action.scope };
    case "listFiles":
      return { label: `List ${action.path === "." ? "this folder" : shortPath(action.path)}`, detail: action.pattern };
    case "unknown":
      return action.run ? { label: action.run.label, detail: action.run.detail ?? null } : null;
  }
}

/** The first pipe outside any `$(…)` or `{…}`, where the rest of the step begins. */
function firstPipe(text: string): number | null {
  let depth = 0;
  for (const token of shellTokens(text)) {
    if (!token.operator) continue;
    if (/^(\$?\(|\{|\$\{)$/.test(token.value)) depth++;
    else if (/^[)}]$/.test(token.value)) depth--;
    else if (depth === 0 && token.value === "|") return token.start;
  }
  return null;
}

/** Where a run's plumbing begins: a pipe into trimmers only, and any merging or silencing just before it. */
function plumbing(text: string): number | null {
  const pipe = firstPipe(text);
  const rest = pipeline(text).slice(1);
  const trims = pipe !== null && rest.length > 0 && rest.every((command) => command.via === "|" && TRIMMERS.test(basename(command.words[0] ?? "")));
  const end = trims ? pipe : text.length;
  const quiet = QUIET.exec(text.slice(0, end));
  const at = quiet ? quiet.index : end;
  return at > 0 && at < text.trimEnd().length ? at : null;
}

/** A step's plain words and plumbing. A printer whose output goes to a file writes that file. */
export function readStep(text: string): StepReading {
  if (text.startsWith("#")) return { label: null, detail: null, plumbing: null };
  const action = readCommand(text)[0] ?? null;
  const said = action ? words(action) : null;
  const target = pipeline(text)[0]?.output?.path;
  const writes = target && target !== "/dev/null" && action?.type === "unknown" && (!said || /^View /.test(said.label));
  const label = writes ? { label: `Write ${basename(target)}`, detail: null } : said;
  // A search's or a read's pipe is part of what it looked for; only a run's output is trimmed for show.
  return { label: label?.label ?? null, detail: label?.detail ?? null, plumbing: !action || action.type === "unknown" ? plumbing(text) : null };
}
