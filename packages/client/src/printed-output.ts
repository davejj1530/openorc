/**
 * A command's printed output read line by line for what each line is, so it can be drawn rather than dumped: a
 * divider the program printed becomes a heading, an error or warning keeps its tone, a `path:line` at the start of a
 * line opens its file, and the notes Claude Code adds around the output read as notes.
 */

/** Where a line names a file: the characters to link, the path, and the line it points at. */
export interface FileRef {
  start: number;
  end: number;
  path: string;
  line: number | null;
}

export type PrintedTone = "bad" | "warn" | "note";

export type PrintedLine = { kind: "rule"; text: string } | { kind: "line"; text: string; tone: PrintedTone | null; ref: FileRef | null };

export interface PrintedOutput {
  /** The exit code Claude Code puts on the first line when a command failed. */
  exit: number | null;
  lines: PrintedLine[];
}

const EXIT = /^Exit code (\d+)(?:\n|$)/;
/** What Claude Code prints in place of output when a command printed nothing. */
const NOTHING = /^\((?:Bash )?completed with no output\)$/;
const HARNESS_NOTE = /^(Shell cwd was reset to |\[This command modified \d+ files? you've)/;

/** A run of one character, with a title inside it or not: `⎯⎯⎯ Failed Tests 1 ⎯⎯⎯`, `=== results ===`, `-----`. */
const RULE = /^\s*([⎯─━═=_~*#-])\1{2,}\s*(.*?)\s*(?:\1{3,})?\s*$/;

const BAD = /^\s*(?:error\b|ERROR\b|ERR!|FAIL(?:ED)?\b|fatal:|panic:|Traceback\b|[×✗✕✖]\s|\w*(?:Error|Exception)\b:)|\berror(?: TS\d+)?:|\s(?:error|✖)\s{2,}|\b[1-9]\d* (?:failed|errors?)\b/;
const WARN = /^\s*(?:\[warn\]|warn(?:ing)?\b|Warning\b|WARN\b|⚠)|\swarning\s{2,}|\bwarning:/;

/** `src/a.ts:12:`, `src/a.ts(12,5):` or a bare path at the start of a line; a lone name only when a line number follows. */
const REF = /^(\s*)((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]*\.[A-Za-z]\w{0,7}|[\w@+-][\w@.+-]*\.[A-Za-z]\w{0,7}(?=:\d|\(\d))(?::(\d+)(?::\d+)?|\((\d+),\d+\))?(?=[\s:]|$)/;

function fileRef(text: string): FileRef | null {
  const match = REF.exec(text);
  if (!match) return null;
  const line = match[3] ?? match[4];
  return { start: match[1]!.length, end: match[0].length, path: match[2]!, line: line ? Number(line) : null };
}

function tone(text: string): PrintedTone | null {
  if (HARNESS_NOTE.test(text)) return "note";
  if (BAD.test(text)) return "bad";
  return WARN.test(text) ? "warn" : null;
}

function readLine(text: string): PrintedLine {
  const rule = RULE.exec(text);
  if (rule) return { kind: "rule", text: rule[2]! };
  return { kind: "line", text, tone: tone(text), ref: fileRef(text) };
}

/** The output's lines, read. Text that only says nothing was printed has no lines. */
export function printedOutput(text: string): PrintedOutput {
  const exit = EXIT.exec(text);
  const body = exit ? text.slice(exit[0].length) : text;
  if (NOTHING.test(body.trim()) || !body.trim()) return { exit: exit ? Number(exit[1]) : null, lines: [] };
  return { exit: exit ? Number(exit[1]) : null, lines: body.split("\n").map(readLine) };
}
