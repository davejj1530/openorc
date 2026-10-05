/**
 * Readers for the shapes tools print: numbered code, search matches, file lists, test summaries, `git status`.
 * Each takes the printed text and returns its structure, or null when the text is not that shape.
 */

export interface MatchLine {
  line: number | null;
  text: string;
  /** A line printed around a match (`-A`, `-B`, `-C`), not a match itself. */
  context?: boolean;
}

export interface MatchGroup {
  path: string;
  lines: MatchLine[];
}

/** How a search printed its lines. */
export interface MatchShape {
  /** The one file searched, whose lines carry no path. */
  file: string | null;
  /** Lines start with their number. */
  numbered: boolean;
  /** Context lines come between matches, marked with `-` where matches have `:`. */
  context: boolean;
}

export interface TestTally {
  passed: number;
  failed: number;
  skipped: number;
}

export type ChangeStatus = "added" | "untracked" | "modified" | "deleted" | "renamed" | "conflict";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

const languages: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "md",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  sh: "sh",
  zsh: "sh",
  bash: "sh",
  py: "py",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  toml: "toml",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  xml: "xml",
  svg: "xml",
};

/** The highlighting language for a file, from its extension; plain text when unknown. */
export function languageFor(path: string | null): string {
  const extension = path ? /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() : undefined;
  return (extension && languages[extension]) || "text";
}

/** Terminal colour codes are noise once the output is read outside a terminal. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** "140\t}" lines, as Claude's Read and `nl -ba` number them: the code without its numbers, from its first number. */
export function numberedCode(text: string): { code: string; startLine: number } | null {
  // Claude Code may append a reminder after the file; it is not part of the file.
  const lines = text.replace(/\n*<system-reminder>[\s\S]*$/, "").split("\n");
  const numbered = lines.map((line) => /^\s*(\d+)(?:\t|→)(.*)$/.exec(line));
  const first = numbered.find(Boolean);
  if (!first || numbered.some((match, index) => !match && lines[index]!.trim())) return null;
  return { code: numbered.map((match) => match?.[2] ?? "").join("\n"), startLine: Number(first[1]) };
}

type Hit = MatchLine & { path: string };

/** A line from several files: `path:12:text`, `path-12-text` around a match, or `path:text` without numbers. */
function pathLine(line: string, context: boolean): Hit | null {
  const hit = /^(.+?):(\d+):(.*)$/.exec(line);
  if (hit) return { path: hit[1]!, line: Number(hit[2]), text: hit[3]! };
  const near = context ? /^(.+?)-(\d+)-(.*)$/.exec(line) : null;
  if (near) return { path: near[1]!, line: Number(near[2]), text: near[3]!, context: true };
  const unnumbered = /^([^\s:]+\.[a-z0-9]+):(.*)$/i.exec(line);
  return unnumbered ? { path: unnumbered[1]!, line: null, text: unnumbered[2]! } : null;
}

/** A line from one file: `12:text`, `12-text` around a match, or the bare line when numbers were not asked for. */
function fileLine(line: string, file: string, shape: MatchShape): Hit | null {
  if (!shape.numbered) return { path: file, line: null, text: line };
  const hit = /^(\d+)([:-])(.*)$/.exec(line);
  if (!hit || (hit[2] === "-" && !shape.context)) return null;
  return hit[2] === "-" ? { path: file, line: Number(hit[1]), text: hit[3]!, context: true } : { path: file, line: Number(hit[1]), text: hit[3]! };
}

/** A search's output grouped by file. Null when too little of it reads as matches. */
export function matchGroups(text: string, shape: MatchShape): MatchGroup[] | null {
  const lines = text.split("\n").filter((line) => line.trim() && line !== "--");
  const groups = new Map<string, MatchGroup>();
  let matched = 0;
  for (const line of lines) {
    const hit = shape.file === null ? pathLine(line, shape.context) : fileLine(line, shape.file, shape);
    if (!hit) continue;
    matched++;
    const { path, ...match } = hit;
    const group = groups.get(path) ?? { path, lines: [] };
    group.lines.push(match);
    groups.set(path, group);
  }
  return lines.length && matched / lines.length >= 0.6 ? [...groups.values()] : null;
}

/** One path per line, as rg --files, ls, find, Glob and Grep's file mode print them. */
export function fileList(text: string): string[] | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Found \d+ files?/.test(line));
  const paths = lines.filter((line) => line.length < 300 && !/\s{2,}|\t/.test(line) && /[/.]/.test(line));
  return lines.length && paths.length / lines.length >= 0.8 ? paths : null;
}

/** The pass and fail counts a test runner prints at the end: vitest, jest, pytest or cargo. */
export function testTally(text: string): TestTally | null {
  const summary =
    /^\s*Tests\s+(.+?)\s*\(\d+\)\s*$/m.exec(text)?.[1] ?? /^Tests:\s+(.+)$/m.exec(text)?.[1] ?? /^=+\s*(.+?) in [\d.]+s\s*=+\s*$/m.exec(text)?.[1] ?? /^test result: \w+\. (.+)$/m.exec(text)?.[1];
  if (!summary) return null;
  const count = (pattern: RegExp) => Number(pattern.exec(summary)?.[1] ?? 0);
  return { passed: count(/(\d+) passed/), failed: count(/(\d+) failed/), skipped: count(/(\d+) (?:skipped|ignored|todo)/) };
}

/** What a `git status` code says happened to a file: `??` is new, `M` changed, `R` renamed, `U` in conflict. */
function changeStatus(code: string): ChangeStatus {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
  if (code.includes("R")) return "renamed";
  if (code.includes("A") || code.includes("C")) return "added";
  return code.includes("D") ? "deleted" : "modified";
}

/** `git status --short` as the files it lists. Null unless every line is one. */
export function gitStatus(text: string): ChangedFile[] | null {
  const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith("## "));
  const files = lines.map((line) => /^([ MTADRCU?]{2}) (.+)$/.exec(line));
  if (!files.length || files.some((match) => !match)) return null;
  return files.map((match) => ({
    // A rename lists where it came from; the file is where it went.
    path: match![2]!.replace(/^.* -> /, "").replace(/^"(.*)"$/, "$1"),
    status: changeStatus(match![1]!),
  }));
}

/** JSON, indented to read. Null when the text is not JSON. */
export function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
