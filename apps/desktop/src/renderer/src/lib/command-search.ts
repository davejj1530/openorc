import { parseArgs, type Args } from "./command-args";
import { basename, unwrapWords } from "./run-labels";
import type { PipedCommand } from "./shell";

/**
 * A grep, rg or the like read for what it looked for and where: the query as quoted terms, the paths and globs it
 * was narrowed to, and whether its output is one line per match.
 */

export const SEARCHERS = /^(grep|egrep|fgrep|rg|ag|ack)$/;

const GREP_VALUED = new Set([
  "e",
  "f",
  "m",
  "A",
  "B",
  "C",
  "D",
  "d",
  "--regexp",
  "--file",
  "--max-count",
  "--context",
  "--after-context",
  "--before-context",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--label",
]);
export const RG_VALUED = new Set([
  ...["e", "f", "g", "t", "T", "m", "A", "B", "C", "M", "j", "r", "E", "d"],
  ...["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context", "--max-columns"],
  ...["--threads", "--replace", "--max-depth", "--sort", "--sortr", "--type-add", "--pre", "--encoding", "--max-filesize", "--ignore-file"],
]);
/** Flags that print something other than every match once: names, counts, context, a capped few, the lines that did not match. */
const UNCOUNTED = [
  ...["l", "L", "c", "q", "A", "B", "C", "m", "v"],
  ...["--count", "--files-with-matches", "--files-without-match", "--quiet", "--json", "--context", "--after-context", "--before-context"],
  ...["--count-matches", "--stats", "--max-count", "--invert-match"],
];

/** A search's words, read by its program's flags. */
export interface SearchArgs {
  args: Args;
  patterns: string[];
  /** The paths and globs after the pattern. */
  operands: string[];
  /** Whether a bare `|` separates alternatives. */
  extended: boolean;
  fixed: boolean;
}

export function searchArgs(name: string, words: string[]): SearchArgs {
  const rg = /^(rg|ag|ack)$/.test(name);
  const args = parseArgs(words, rg ? RG_VALUED : GREP_VALUED);
  const given = args.values.get("e") ?? args.values.get("--regexp");
  return {
    args,
    patterns: given ?? args.positional.slice(0, 1),
    operands: given ? args.positional : args.positional.slice(1),
    extended: rg || name === "egrep" || args.flags.has("E") || args.flags.has("P"),
    fixed: args.flags.has("F") || name === "fgrep",
  };
}

/** `grep -v` prints the lines that did not match. */
export const inverted = (search: SearchArgs) => search.args.flags.has("v") || search.args.flags.has("--invert-match");
/** A pattern such as "", "^" or "$" matches every line. */
export const matchesAll = (search: SearchArgs) => search.patterns.every((pattern) => /^\^?\$?$/.test(pattern));
export const recursive = (search: SearchArgs) => ["r", "R", "--recursive"].some((flag) => search.args.flags.has(flag));

/** What a search looked for, as quoted terms: “a”, “b” or “c”. Every `-e` adds its own. */
export function searchQuery(search: SearchArgs): string {
  if (search.fixed) return quoteList(search.patterns);
  const terms = search.patterns.flatMap((pattern) => patternTerms(pattern, search.extended));
  return quoteList(terms.length ? [...new Set(terms)] : search.patterns);
}

/** Where a search looked: its paths, then its globs. */
export function searchScope(search: SearchArgs): string | null {
  const paths = search.operands.filter((path) => !/[*?[]/.test(path) && !path.startsWith(":"));
  const globs = search.operands.filter((path) => /[*?[]/.test(path) && !/^:(!|\(exclude\))/.test(path)).map((path) => shortGlob(path.replace(/^:\(glob\)/, "")));
  return scopeOf(paths, [...globs, ...globsOf(search.args)]);
}

/** Whether every line the search printed is one match: no flag changes that, and nothing after it cuts or counts. */
export function countable(search: SearchArgs, rest: PipedCommand[], redirected: boolean): boolean {
  return !UNCOUNTED.some((flag) => search.args.flags.has(flag)) && !redirected && rest.every(keepsMatches);
}

/** A command after a search that leaves its lines one match each: another filter, a sort, or `|| true`. */
function keepsMatches(next: PipedCommand): boolean {
  const name = basename(unwrapWords(next.words)[0] ?? "");
  if (next.via === "||") return /^(true|:)$/.test(name);
  return next.via === "|" && /^(grep|egrep|rg|sort)$/.test(name) && !next.words.some((word) => /^-\w*[cqlum]/.test(word));
}

/** The globs a search or listing was narrowed to, without the ones that leave files out. */
export function globsOf(args: Args): string[] {
  const globs = [...(args.values.get("--include") ?? []), ...(args.values.get("g") ?? []), ...(args.values.get("--glob") ?? []), ...(args.values.get("--iglob") ?? [])];
  const types = [...(args.values.get("t") ?? []), ...(args.values.get("--type") ?? [])].map((type) => `${type} files`);
  return [...globs.filter((glob) => !glob.startsWith("!")), ...types];
}

/** The part of a path after its last variable: `$LOG/run.log` is somewhere, but it is run.log. */
function known(path: string): string {
  const variable = path.lastIndexOf("$");
  if (variable < 0) return path;
  const slash = path.indexOf("/", variable);
  return slash < 0 ? "" : path.slice(slash + 1);
}

/** Where a search looked, short: "in claude/adapter.ts, *.ts". */
export function scopeOf(paths: string[], globs: string[]): string | null {
  const shown = paths
    .map(known)
    .filter((path) => path && !/^\.\/?$/.test(path))
    .map(shortPath);
  const where = shown.length > 2 ? `in ${shown.slice(0, 2).join(", ")} and ${shown.length - 2} more` : `in ${shown.join(", ")}`;
  return [shown.length ? where : "", ...globs].filter(Boolean).join(", ") || null;
}

/** A path's last two names: enough to place it without the whole path. */
export function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || path;
}

/** A glob, short, unless `**` reaches across folders, which only reads whole. */
export const shortGlob = (glob: string) => (glob.includes("**") ? glob : shortPath(glob));

/** Each alternative of a pattern, quoted: “a”, “b” or “c”. `extended` is whether a bare `|` separates them. */
export function searchTerms(pattern: string, extended: boolean): string {
  const terms = patternTerms(pattern, extended);
  return quoteList(terms.length ? terms : [pattern]);
}

function patternTerms(pattern: string, extended: boolean): string[] {
  const anchored = pattern.replace(/^\^/, "").replace(/(?<!\\)\$$/, "");
  return [...new Set(alternatives(anchored, extended).map(cleanTerm).filter(Boolean))];
}

export function quoteList(terms: string[]): string {
  const quoted = terms.map((term) => `“${term}”`);
  if (quoted.length > 3) return `${quoted.slice(0, 3).join(", ")} and ${quoted.length - 3} more`;
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}` : (quoted[0] ?? "");
}

/**
 * Splits a regex on its top-level alternation: `|` when extended, `\|` in a basic regex. Groups stay whole, except
 * one that wraps the whole pattern: `(a|b)` reads as a and b.
 */
function alternatives(pattern: string, extended: boolean): string[] {
  const [open, close, bar] = extended ? ["(", ")", "|"] : ["\\(", "\\)", "\\|"];
  const parts = [""];
  let depth = 0;
  let wrapped = pattern.startsWith(open) && pattern.endsWith(close);
  for (let at = 0; at < pattern.length; at += pattern[at] === "\\" ? 2 : 1) {
    const token = pattern[at] === "\\" ? pattern.slice(at, at + 2) : pattern[at]!;
    if (token === bar && depth === 0) parts.push("");
    else parts[parts.length - 1] += token;
    if (token === open) depth++;
    if (token === close) depth = Math.max(0, depth - 1);
    if (depth === 0 && at + token.length < pattern.length) wrapped = false;
  }
  return wrapped && parts.length === 1 ? alternatives(pattern.slice(open.length, -close.length), extended) : parts;
}

/** Regex a reader would have to work out: a class, a count such as `{2}`, a repeat, or an escape such as `\w`. */
const STILL_REGEX = /(?<!\\)[[\]+?*]|\\?\{\d|\\[dDwWsS]/;

/**
 * A term without the regex noise a reader does not need: anchors, word edges, `.*`. Escapes before punctuation
 * come off only when nothing else in the term is regex; otherwise `\[` would read as a class, so it stays as written.
 */
function cleanTerm(term: string): string {
  const plain = term
    .replace(/^\^/, "")
    .replace(/(?<!\\)\$$/, "")
    .replace(/\\[b<>]/g, "")
    .replace(/\.\*|\.\+/g, "…")
    .trim();
  // An escaped quote is never regex, only how the quote got through the shell.
  const quoted = plain.replace(/\\+(["'])/g, "$1");
  return STILL_REGEX.test(quoted) ? quoted : quoted.replace(/\\([^\w\s])/g, "$1");
}
