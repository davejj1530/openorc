import { stripAnsi } from "./tool-text.js";
/**
 * A command as a reader wants it: what it ran apart from where it ran, with the machine's long paths cut to the part
 * that tells them apart.
 */
export interface CommandWords {
  command: string;
  /** Where it ran, when it began by going there and that is not the project itself. */
  folder: string | null;
}

/** A home folder at the start of a path or after a break in a command. */
const HOME_PATH = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;
const HOME_INSIDE = /(^|[\s"'=(:])\/(?:Users|home)\/[^/\s"']+(?=[/\s"']|$)/g;
const LEADING_CD = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&]+)\s*(?:&&|;)\s*/;
/** Folders of a place kept when it is long: enough to tell it from its neighbours. */
const KEPT = 2;

/** A path as written for a reader: inside the project it is relative, under the home folder it starts at `~`. */
export function shortPath(path: string, base?: string | null): string {
  const root = base?.replace(/\/+$/, "");
  if (root && path === root) return ".";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path.replace(HOME_PATH, "~");
}

/** A folder by its last names, when the whole way there is long. */
function place(folder: string): string {
  const parts = folder.split("/").filter(Boolean);
  return parts.length > KEPT + 1 ? `…/${parts.slice(-KEPT).join("/")}` : folder;
}

export function commandWords(command: string, base?: string | null): CommandWords {
  const cd = LEADING_CD.exec(command);
  const rest = cd ? command.slice(cd[0].length) : command;
  // A command that only goes somewhere is shown as written.
  if (!rest.trim()) return { command: command.replace(HOME_INSIDE, "$1~"), folder: null };
  const root = base?.replace(/\/+$/, "");
  const inside = root ? rest.split(`${root}/`).join("") : rest;
  const folder = cd ? shortPath(cd[1]!.replace(/^["']|["']$/g, ""), base) : null;
  return { command: inside.replace(HOME_INSIDE, "$1~"), folder: !folder || folder === "." ? null : place(folder) };
}

export interface OutputLine {
  text: string;
  /** How the line reads at a glance: a pass, a failure, or neither. */
  tone: "ok" | "bad" | null;
}

const BAD = /✗|×|\bFAIL(?:ED)?\b|\bfailed\b|\berror\b|\bERR!|\bError:|\bnot ok\b|\bfatal:|\bno matches found\b|\bcommand not found\b|\bNo such file\b|\bPermission denied\b|^Traceback\b/i;
const OK = /✓|✔|\bPASS(?:ED)?\b|\bpassed\b|\bsuccess(?:ful(?:ly)?)?\b|\bno errors\b/i;
/** "0 failed" and "0 errors" are good news. */
const NO_BAD = /\b(?:0|no) (?:failed|failures|errors?)\b/gi;

/** A failure outweighs a pass on the same line. `judged`: the line without the good news that reads as bad. */
function toneOf(text: string, judged: string): OutputLine["tone"] {
  if (BAD.test(judged)) return "bad";
  return OK.test(text) ? "ok" : null;
}

/** The last lines a command printed, without terminal colour codes, each read as a pass, a failure or neither. */
export function outputLines(output: string, limit: number): { lines: OutputLine[]; hidden: number } {
  const all = stripAnsi(output)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  while (all.length && !all[0]!.trim()) all.shift();
  while (all.length && !all[all.length - 1]!.trim()) all.pop();
  // A run of empty lines is one: the screen is small.
  const dense = all.filter((line, at) => line.trim() || all[at - 1]?.trim());
  const kept = dense.slice(-limit);
  const lines = kept.map((text): OutputLine => {
    const judged = text.replace(NO_BAD, "");
    return { text, tone: toneOf(text, judged) };
  });
  return { lines, hidden: dense.length - kept.length };
}
