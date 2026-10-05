import { isUnifiedDiff, toolDiff } from "./chat-diff";
import { commandLine, shellSteps, shellTokens, unwrapShell, type CommandLine, type ShellStep } from "./shell";
import { fileList, gitStatus, languageFor, matchGroups, numberedCode, prettyJson, stripAnsi, testTally, type ChangedFile, type MatchGroup, type MatchShape, type TestTally } from "./tool-text";
import type { Block } from "./transcript";

/**
 * What a tool call's input and output are, so each renders as itself rather than as JSON and plain text: a command
 * as the steps it ran, a printed file as highlighted code, a search as its matches, a test run as its tally.
 * Anything not recognised falls back to readable text; the raw call stays one click away.
 */
type ToolBlock = Extract<Block, { kind: "tool" }>;

export interface Field {
  key: string;
  value: string;
  /** An object or array, shown as formatted JSON rather than inline. */
  structured: boolean;
}

export interface CommandStep {
  /** The step as written. One that starts with `#` is a comment the agent left. */
  text: string;
  /** The script or file content the step feeds in, highlighted as what it is. */
  body: { code: string; language: string } | null;
}

export type InputView =
  | { kind: "command"; steps: CommandStep[]; cwd: string | null }
  | { kind: "file"; path: string; lines: string | null }
  | { kind: "patch"; patch: string }
  | { kind: "edit"; path: string; before: string; after: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "search"; pattern: string; scope: string | null; flags: string[] }
  | { kind: "web"; target: string }
  | { kind: "prompt"; text: string; agent: string | null }
  | { kind: "fields"; fields: Field[] }
  | { kind: "none" };

export type OutputView =
  | { kind: "code"; code: string; language: string; startLine: number | null; path: string | null }
  | { kind: "matches"; groups: MatchGroup[]; pattern: string | null }
  | { kind: "files"; paths: string[] }
  | { kind: "changes"; files: ChangedFile[] }
  | { kind: "diff"; patch: string }
  | { kind: "tests"; tally: TestTally; text: string }
  | { kind: "json"; json: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string };

type Input = Record<string, unknown>;

const record = (value: unknown): Input | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Input) : null);
const str = (input: Input | null, ...keys: string[]) => keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0) ?? "";
/** The tool's own name, without the MCP server prefix in either provider's naming. */
const toolName = (name: string) => name.replace(/^mcp__.+?__/, "").replace(/^[^.]+\./, "");
/** A path that names one file: it has an extension, and no glob that could stand for several. */
const looksLikeFile = (path: string) => /\.[A-Za-z0-9]+$/.test(path) && !/[*?[{]/.test(path);

/** The shell command a call ran, out of the `zsh -lc` wrapper and the quotes Codex runs it in. */
export function commandOf(input: Input | null): string {
  const raw = input?.["command"] ?? input?.["cmd"];
  const parts = Array.isArray(raw) ? raw : [raw];
  return unwrapShell(parts.filter((part): part is string => typeof part === "string").join(" "));
}

/** A path as seen from `folder`, the folder a command ran in. */
export function joinPath(folder: string | null, path: string): string {
  if (!folder || /^([/~]|[A-Za-z]:[\\/])/.test(path)) return path;
  return `${folder.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** Programs that read code: the language they read, and the flag that hands them code inline. */
const PROGRAMS: { name: RegExp; language: string; inline: RegExp | null }[] = [
  { name: /^python[\d.]*$/, language: "py", inline: /^-c$/ },
  { name: /^(node|bun)$/, language: "js", inline: /^(-e|--eval|-p|--print)$/ },
  { name: /^(deno|tsx|ts-node)$/, language: "ts", inline: /^(-e|--eval|-p|--print)$/ },
  { name: /^(bash|sh|zsh)$/, language: "sh", inline: /^-\w*c$/ },
  { name: /^ruby$/, language: "ruby", inline: /^-e$/ },
  { name: /^perl$/, language: "perl", inline: /^-[eE]$/ },
  { name: /^(sqlite3|psql|mysql|duckdb)$/, language: "sql", inline: null },
];
/** Words that run the word after them: `env FOO=1 node`, `npx tsx`. */
const WRAPPER = /^([A-Za-z_]\w*=.*|env|exec|time|npx|sudo|command|nice)$/s;

function program(word: string | undefined) {
  const name = word?.split("/").pop() ?? "";
  return PROGRAMS.find((entry) => entry.name.test(name)) ?? null;
}

/** What a heredoc is written in: the file it goes to, or the program that reads it. */
function fedLanguage(line: CommandLine): string {
  const words = line.words.filter((word) => !WRAPPER.test(word));
  const file = line.output?.path ?? (words[0] === "tee" ? words[words.length - 1] : undefined);
  return file ? languageFor(file) : (program(words[0])?.language ?? "text");
}

/** `node -e '…'` or `python3 -c '…'` with code over several lines: the program as the step, the code as its script. */
function inlineScript(text: string): CommandStep | null {
  const tokens = shellTokens(text);
  const at = tokens.findIndex((token) => !token.operator && !WRAPPER.test(token.value));
  const runs = program(tokens[at]?.value);
  const inline = runs?.inline;
  const flag = inline ? tokens.findIndex((token, index) => index > at && !token.operator && inline.test(token.value)) : -1;
  const code = flag > 0 ? tokens[flag + 1] : undefined;
  if (!runs || !code || code.operator || !code.value.includes("\n")) return null;
  return { text: `${text.slice(0, code.start).trimEnd()} ${text.slice(code.end).trimStart()}`.trim(), body: { code: code.value.replace(/^\s*\n|\s+$/g, ""), language: runs.language } };
}

function commandStep(step: ShellStep): CommandStep {
  if (step.input !== null) return { text: step.text, body: { code: step.input, language: fedLanguage(commandLine(step.text)) } };
  return inlineScript(step.text) ?? { text: step.text, body: null };
}

/** A command as the steps it runs. A leading `cd` says where the rest runs, so it reads as the folder instead. */
function commandSteps(command: string, cwd: string): { steps: CommandStep[]; cwd: string | null } {
  const steps = shellSteps(command);
  const [cd, folder, ...rest] = steps.length > 1 ? commandLine(steps[0]!.text).words : [];
  const moved = cd === "cd" && folder !== undefined && !rest.length;
  return { steps: (moved ? steps.slice(1) : steps).map(commandStep), cwd: moved ? joinPath(cwd || null, folder) : cwd || null };
}

function searchFlags(input: Input): string[] {
  const flags: string[] = [];
  if (input["-i"] === true) flags.push("ignore case");
  if (typeof input["glob"] === "string") flags.push(input["glob"]);
  if (typeof input["type"] === "string") flags.push(`${input["type"]} files`);
  if (input["output_mode"] === "content") flags.push("with lines");
  return flags;
}

function fields(input: Input): Field[] {
  return Object.entries(input).flatMap(([key, value]) => {
    if (value === undefined || value === null || value === "") return [];
    const structured = typeof value === "object";
    return [{ key, value: structured ? JSON.stringify(value, null, 2) : String(value), structured }];
  });
}

/** A Claude edit as the text it replaced and the text it wrote; several edits read as one before and after. */
function editView(name: string, input: Input): InputView | null {
  const path = str(input, "file_path", "path", "notebook_path");
  if (/^(edit|str_replace)$/i.test(name) && typeof input["old_string"] === "string" && typeof input["new_string"] === "string")
    return { kind: "edit", path, before: input["old_string"], after: input["new_string"] };
  const edits = Array.isArray(input["edits"]) ? (input["edits"] as Input[]) : null;
  if (/^multiedit$/i.test(name) && edits)
    return { kind: "edit", path, before: edits.map((edit) => str(edit, "old_string")).join("\n\n"), after: edits.map((edit) => str(edit, "new_string")).join("\n\n") };
  if (/^(write|write_file|create_file)$/i.test(name) && typeof input["content"] === "string") return { kind: "write", path, content: input["content"] };
  return null;
}

/** What a call was asked to do, in the shape that reads best for that kind of call. */
export function toolInputView(block: ToolBlock): InputView {
  const name = toolName(block.name);
  const input = record(block.input);
  const patch = /^apply_patch$/i.test(name) ? toolDiff(block.input) : null;
  if (patch) return { kind: "patch", patch };
  const command = commandOf(input);
  if (command) return { kind: "command", ...commandSteps(command, str(input, "cwd", "workdir")) };
  if (!input) return { kind: "none" };
  const known = readView(name, input) ?? editView(name, input) ?? lookupView(name, input);
  if (known) return known;
  const list = fields(input);
  return list.length ? { kind: "fields", fields: list } : { kind: "none" };
}

function readView(name: string, input: Input): InputView | null {
  if (!/^(read|read_file|view|notebookread)$/i.test(name)) return null;
  const offset = Number(input["offset"]);
  const limit = Number(input["limit"]);
  const range = limit > 0 ? `lines ${offset}–${offset + limit - 1}` : `from line ${offset}`;
  const lines = offset > 0 ? range : null;
  return { kind: "file", path: str(input, "file_path", "path", "notebook_path"), lines };
}

/** Searches, pages and subagents: what was looked for, where, and how. */
function lookupView(name: string, input: Input): InputView | null {
  if (/^(grep|glob|search)$/i.test(name)) return { kind: "search", pattern: str(input, "pattern", "query"), scope: str(input, "path") || null, flags: searchFlags(input) };
  if (/^(webfetch|fetch|websearch)$/i.test(name)) return { kind: "web", target: str(input, "url", "query") };
  if (/^(task|agent)$/i.test(name) && str(input, "prompt")) return { kind: "prompt", text: str(input, "prompt"), agent: str(input, "subagent_type") || null };
  return null;
}

/** Commands that print nothing when they work, so a step of them leaves the output to the others. */
const SILENT = /^(cd|pushd|popd|export|unset|set|source|\.|mkdir|rm|rmdir|cp|mv|touch|chmod|ln|test|\[\[?|true|:|sleep|wait|trap|shopt|local|declare)$/;

/** A step that prints nothing: a comment, a quiet command, an assignment, or one whose output goes to a file. */
function silent(step: ShellStep): boolean {
  if (step.text.startsWith("#")) return true;
  const line = commandLine(step.text);
  if (line.output) return true;
  if (line.next.length || !line.words.length) return false;
  const name = line.words.find((word) => !/^[A-Za-z_]\w*=/.test(word));
  return name === undefined || SILENT.test(name);
}

interface Printed {
  paths: string[];
  /** The file's line the print starts at, when that is known. */
  startLine: number | null;
}

/** The programs that print files, the flags of theirs that take a value, and whether they print from the top. */
const PRINTERS = new Map<string, { valued: RegExp; fromTop: boolean }>([
  ["cat", { valued: /(?!)/, fromTop: true }],
  ["nl", { valued: /^-[bdfhilnsvw]$/, fromTop: true }],
  ["head", { valued: /^-[nc]$/, fromTop: true }],
  ["tail", { valued: /^-[nc]$/, fromTop: false }],
]);

/** A command's operands: its words past the flags and the values its `valued` flags take. */
function operands(args: string[], valued: RegExp): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (valued.test(arg)) index++;
    else if (!arg.startsWith("-") || arg === "-") found.push(arg);
  }
  return found;
}

/** `sed -n 60,80p a.ts` prints a.ts from line 60. */
function sedPrint(args: string[]): Printed | null {
  const [flag, script = "", file, ...rest] = args;
  const range = flag === "-n" && file !== undefined && !rest.length ? /^(\d+)(?:,(?:\d+|\$))?p$/.exec(script) : null;
  return range && file ? { paths: [file], startLine: Number(range[1]) } : null;
}

function filePrint([name = "", ...args]: string[]): Printed | null {
  if (name === "sed") return sedPrint(args);
  const printer = PRINTERS.get(name);
  const paths = printer ? operands(args, printer.valued) : [];
  return printer && paths.length ? { paths, startLine: printer.fromTop ? 1 : null } : null;
}

/** The files a step prints and where the print starts: `sed -n 60,80p a.ts`, `cat a.ts b.ts`, `head -n 20 a.ts`. */
export function printedFile(line: CommandLine): Printed | null {
  if (line.next.some((name) => !/^(head|tail|sed)$/.test(name))) return null;
  const printed = filePrint(line.words);
  // After `| sed` or `| tail`, the lines shown no longer start where the file's did.
  return printed && line.next.some((name) => name !== "head") ? { ...printed, startLine: null } : printed;
}

type CommandAction = { type?: unknown; path?: unknown; name?: unknown; query?: unknown };

/** Codex's own reading of a command, when it gave one: what it read or searched for. */
function commandAction(input: Input | null): CommandAction | null {
  const actions = input?.["commandActions"];
  return Array.isArray(actions) && actions.length === 1 ? (record(actions[0]) as CommandAction | null) : null;
}

/** The files the printing steps print, when every one of them prints files. */
function filesPrinted(lines: CommandLine[], action: CommandAction | null): Printed | null {
  const reads = lines.map(printedFile);
  if (reads.length && reads.every((read): read is Printed => read !== null)) return { paths: reads.flatMap((read) => read.paths), startLine: reads[0]!.startLine };
  const path = lines.length === 1 && action?.type === "read" ? String(action.path ?? action.name ?? "") : "";
  return path ? { paths: [path], startLine: null } : null;
}

/** Printed files as their code: highlighted when they share a language, numbered when one file and its start are known. */
function printedCode(block: ToolBlock, lines: CommandLine[], action: CommandAction | null, text: string): OutputView | null {
  const printed = block.isError ? null : filesPrinted(lines, action);
  const languages = new Set(printed?.paths.map(languageFor));
  const one = printed?.paths.length === 1 && !/[*?[$]/.test(printed.paths[0]!) ? printed.paths[0]! : null;
  if (!printed || languages.size !== 1 || (!one && languages.has("text"))) return null;
  const numbered = numberedCode(text);
  return { kind: "code", code: numbered?.code ?? text, language: [...languages][0]!, startLine: one ? (numbered?.startLine ?? printed.startLine) : null, path: one };
}

interface Search extends MatchShape {
  pattern: string | null;
  /** What the search prints: matching lines, the files with matches, or counts. */
  mode: "lines" | "files" | "count";
}

/** Search flags that take the next word as their value, for rg and grep alike. */
const VALUED =
  /^(-[efgtTABCmMd]|--(regexp|file|glob|iglob|type|type-not|after-context|before-context|context|max-count|max-columns|max-depth|include|exclude|exclude-dir|sort|sortr|colors?|encoding))$/;

function searchArgs(args: string[]): { flags: string[]; pattern: string | null; targets: string[] } {
  const flags: string[] = [];
  const positional: string[] = [];
  let pattern: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") positional.push(arg);
    else flags.push(arg);
    if (!VALUED.test(arg)) continue;
    if (/^(-e|--regexp)$/.test(arg)) pattern ??= args[index + 1] ?? null;
    index++;
  }
  return pattern === null ? { flags, pattern: positional[0] ?? null, targets: positional.slice(1) } : { flags, pattern, targets: positional };
}

/** grep's basic expressions write alternation and groups as `\|` and `\(…\)`; the highlighter reads them unescaped. */
function readablePattern(name: string, has: (flag: RegExp) => boolean, pattern: string | null): string | null {
  const basic = name === "grep" && !has(/^(-[a-zA-Z]*[EP][a-zA-Z]*|--(extended|perl)-regexp)$/);
  return basic && pattern ? pattern.replace(/\\([|()])/g, "$1") : pattern;
}

function searchMode(has: (flag: RegExp) => boolean): Search["mode"] {
  if (has(/^(-[a-zA-Z]*l[a-zA-Z]*|--files(-with-matches)?)$/)) return "files";
  return has(/^(-[a-zA-Z]*c[a-zA-Z]*|--count(-matches)?)$/) ? "count" : "lines";
}

/** An `rg`, `grep` or `git grep` step: what it looked for, in which file if one, and how it prints what it found. */
function searchOf(line: CommandLine): Search | null {
  const [name = "", ...args] = line.words;
  const git = name === "git" && args[0] === "grep";
  if (!git && !/^(rg|grep|egrep|fgrep)$/.test(name)) return null;
  const { flags, pattern, targets } = searchArgs(git ? args.slice(1) : args);
  const has = (flag: RegExp) => flags.some((value) => flag.test(value));
  const one = targets.length === 1 && looksLikeFile(targets[0]!) && !has(/^(-H|--with-filename)$/);
  return {
    pattern: readablePattern(name, has, pattern),
    mode: searchMode(has),
    file: one ? targets[0]! : null,
    numbered: has(/^(-[a-zA-Z]*n|--line-number|--vimgrep)/),
    context: has(/^(-[a-zA-Z]*[ABC]\d*|--(after-|before-)?context)/),
  };
}

/**
 * The matches of one search, or of several in a row when each prints its paths so every line says where it is from.
 * Whatever the output went through on the way, the lines have to read as matches.
 */
function matchesView(searches: (Search | null)[], action: CommandAction | null, text: string): OutputView | null {
  const found = searches.filter((search): search is Search => search?.mode === "lines");
  const single = found.length === 1 ? found[0]! : null;
  const shape = single ?? (found.length && found.every((search) => search.file === null) ? { file: null, numbered: true, context: found.some((search) => search.context) } : null);
  const groups = shape && found.length === searches.length ? matchGroups(text, shape) : null;
  const patterns = found.flatMap((search) => (search.pattern ? [search.pattern] : []));
  const query = typeof action?.query === "string" ? action.query : null;
  return groups ? { kind: "matches", groups, pattern: patterns.length ? patterns.join("|") : query } : null;
}

function filesView({ words }: CommandLine, search: Search | null, action: CommandAction | null, text: string): OutputView | null {
  const lister = /^(find|fd|ls)$/.test(words[0] ?? "") || (words[0] === "git" && words[1] === "ls-files");
  const paths = search?.mode === "files" || lister || action?.type === "listFiles" ? fileList(text) : null;
  return paths ? { kind: "files", paths } : null;
}

/** Search matches, or a listing's files when one step printed them. */
function listing(block: ToolBlock, lines: CommandLine[], action: CommandAction | null, text: string): OutputView | null {
  if (block.isError || !lines.length) return null;
  const searches = lines.map(searchOf);
  const one = lines.length === 1 ? lines[0]! : null;
  return matchesView(searches, action, text) ?? (one ? filesView(one, searches[0]!, action, text) : null);
}

/** `git status --short` as the files it lists, when that is all the command printed. */
function changes(lines: CommandLine[], text: string): OutputView | null {
  const asked = lines.some(({ words }) => words[0] === "git" && words[1] === "status" && words.some((word) => /^(-s\w*|--short|--porcelain(=v1)?)$/.test(word)));
  const files = asked ? gitStatus(text) : null;
  return files ? { kind: "changes", files } : null;
}

function json(text: string): OutputView | null {
  const pretty = prettyJson(text);
  return pretty === null ? null : { kind: "json", json: pretty };
}

function commandOutput(block: ToolBlock, command: string, text: string): OutputView {
  const lines = shellSteps(command)
    .filter((step) => !silent(step))
    .map((step) => commandLine(step.text));
  const action = commandAction(record(block.input));
  const tally = testTally(text);
  return (
    printedCode(block, lines, action, text) ??
    (isUnifiedDiff(text) ? { kind: "diff", patch: text } : null) ??
    (tally ? { kind: "tests", tally, text } : null) ??
    listing(block, lines, action, text) ??
    changes(lines, text) ??
    json(text) ?? { kind: "text", text }
  );
}

/** How Claude's Grep prints content: one file's lines without their path, numbered unless `-n` is off. */
function grepShape(input: Input | null): MatchShape {
  const path = str(input, "path");
  return { file: looksLikeFile(path) ? path : null, numbered: input?.["-n"] !== false, context: ["-A", "-B", "-C", "context"].some((key) => Number(input?.[key]) > 0) };
}

/** What came back, in the shape that reads best. Null when there is nothing to show. */
export function toolOutputView(block: ToolBlock, raw: string): OutputView | null {
  // Trailing blank lines go; the last line keeps its own whitespace, as a numbered empty line ("87\t") needs it.
  const text = stripAnsi(raw).replace(/(?:\r?\n[ \t]*)+$/, "");
  if (!text.trim()) return null;
  const name = toolName(block.name);
  const input = record(block.input);
  const command = commandOf(input);
  if (command) return commandOutput(block, command, text);
  if (/^(read|read_file|view)$/i.test(name)) {
    const path = str(input, "file_path", "path");
    const code = numberedCode(text);
    if (code) return { kind: "code", ...code, language: languageFor(path), path };
  }
  if (/^grep$/i.test(name)) {
    const groups = input?.["output_mode"] === "content" ? matchGroups(text, grepShape(input)) : null;
    if (groups) return { kind: "matches", groups, pattern: str(input, "pattern") || null };
  }
  const paths = /^(grep|glob)$/i.test(name) ? fileList(text) : null;
  if (paths) return { kind: "files", paths };
  if (/^(task|agent|webfetch|fetch)$/i.test(name)) return { kind: "markdown", text };
  return json(text) ?? { kind: "text", text };
}
