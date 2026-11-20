import type { CaseResult } from "@openorc/protocol";
import { stripAnsi } from "./tool-text.js";

/**
 * A test run read for a person: its files, and under each the cases that failed with what went wrong and where.
 * The counts of a run are the digest's (`TestRun`); this reads the rest of what the runner printed, for vitest, jest
 * and pytest. Output that names no file, such as a run cut down to its summary, reads as no files.
 */

/** One line of a failure's trace: a file and the line in it. `library`: code the project did not write. */
export interface TestFrame {
  path: string;
  line: number;
  library: boolean;
}

export interface TestCaseFailure {
  name: string;
  /** What went wrong, as the runner said it: "AssertionError: expected 423, got 401". */
  message: string;
  /** What it expected and what it got, as printed. */
  detail: string[];
  frames: TestFrame[];
}

export interface TestFile {
  path: string;
  state: CaseResult;
  passed: number;
  failed: number;
  skipped: number;
  ms: number | null;
  failures: TestCaseFailure[];
}

/** Lines of a failure's detail kept; the rest is the runner's whole output to show. */
const DETAIL = 12;
const LIBRARY = /(^|\/)node_modules\/|^node:|\/site-packages\/|^internal\//;

const frame = (path: string, line: string): TestFrame => ({ path, line: Number(line), library: LIBRARY.test(path) });

const plain = (text: string) => stripAnsi(text).split("\n");

/** The files of a run by path, made as they are first named. */
class Files {
  private readonly byPath = new Map<string, TestFile>();

  at(path: string): TestFile {
    const known = this.byPath.get(path);
    if (known) return known;
    const file: TestFile = { path, state: "passed", passed: 0, failed: 0, skipped: 0, ms: null, failures: [] };
    this.byPath.set(path, file);
    return file;
  }

  /** Each file as it came out: failed where a case failed, skipped where none ran. */
  all(): TestFile[] {
    return [...this.byPath.values()].map((file) => {
      const failed = Math.max(file.failed, file.failures.length);
      const quiet: CaseResult = !file.passed && file.skipped ? "skipped" : file.state;
      return { ...file, failed, state: failed ? "failed" : quiet };
    });
  }
}

const lastPart = (title: string, separator: string) => title.split(separator).at(-1)!.trim();

/** A failure's body: its first line is what went wrong, the lines after say what was expected and got. */
function told(body: string[]): Pick<TestCaseFailure, "message" | "detail"> {
  const lines = body.map((line) => line.trimEnd());
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return { message: "", detail: [] };
  const detail = lines
    .slice(first + 1)
    .filter((line) => line.trim())
    .slice(0, DETAIL);
  return { message: lines[first]!.trim(), detail };
}

/** A failure still being read: what the runner said about it so far, and the trace it printed. */
interface Telling {
  name: string;
  body: string[];
  frames: TestFrame[];
}

/**
 * One more line of a failure: a line of its trace where it names one (`at`), else part of what went wrong, up to
 * the first trace line. `code`: the source the runner prints around the failing line, which the trace's link opens.
 */
function tell(failure: Telling, line: string, at: RegExpExecArray | null, code: RegExp) {
  if (at) failure.frames.push(frame(at[1]!, at[2]!));
  else if (!failure.frames.length && !code.test(line)) failure.body.push(line);
}

/* ------------------------------------------------------------------ vitest */

const VITEST_FILE = /^ ([✓❯×↓]) (?:\|[^|]+\| )?(\S+) \((\d+) tests?((?: \| \d+ \w+)*)\)(?: (\d+)ms)?/;
/** One case on its own line, as the verbose reporter lists them. */
const VITEST_CASE = /^ ([✓×↓]) (?:\|[^|]+\| )?(\S+) > .+$/;
const VITEST_MARKS: Record<string, "passed" | "failed" | "skipped"> = { "✓": "passed", "×": "failed", "↓": "skipped" };
/** A failure's head: the file and the case, or the file alone in brackets when it could not load. */
const VITEST_FAIL = /^ FAIL {1,2}(?:\|[^|]+\| )?(\S+?)(?: > (.+)| \[ .+ \])?$/;
const VITEST_FRAME = /^ ❯ (?:.+ )?(\S+?):(\d+):\d+$/;
/** The code vitest prints under a frame, which the frame's link opens instead. */
const VITEST_CODE = /^\s+\d*\|/;

function vitestCounts(file: TestFile, total: number, parts: string) {
  const counted = (word: string) => Number(new RegExp(String.raw`(\d+) ${word}`).exec(parts)?.[1] ?? 0);
  file.failed = counted("failed");
  file.skipped = counted("skipped") + counted("todo");
  file.passed = total - file.failed - file.skipped;
}

function vitest(lines: string[]): TestFile[] {
  const files = new Files();
  let failure: (Telling & { file: TestFile }) | null = null;
  const close = () => {
    if (failure) failure.file.failures.push({ name: failure.name, ...told(failure.body), frames: failure.frames });
    failure = null;
  };
  for (const line of lines) {
    const listed = VITEST_FILE.exec(line);
    const failed = VITEST_FAIL.exec(line);
    const one = VITEST_CASE.exec(line);
    if (one) files.at(one[2]!)[VITEST_MARKS[one[1]!]!] += 1;
    else if (listed) {
      const file = files.at(listed[2]!);
      vitestCounts(file, Number(listed[3]), listed[4] ?? "");
      file.ms = listed[5] ? Number(listed[5]) : null;
    } else if (failed) {
      close();
      // A file that could not load has no case to name.
      failure = { file: files.at(failed[1]!), name: failed[2] ? lastPart(failed[2], " > ") : "The file did not load", body: [], frames: [] };
    } else if (failure && /^⎯|^ +Test Files /.test(line)) close();
    else if (failure) tell(failure, line, VITEST_FRAME.exec(line), VITEST_CODE);
  }
  close();
  return files.all();
}

/* ------------------------------------------------------------------ jest */

const JEST_FILE = /^ ?(PASS|FAIL) {1,2}(\S+)(?: \(([\d.]+) ?(m?s)\))?/;
const JEST_FRAME = /^\s+at (?:.+ \()?([^()\s]+?):(\d+):\d+\)?$/;
/** The code jest prints around the failing line. */
const JEST_CODE = /^\s+(>\s+)?\d+ \||^\s+\|/;
const JEST_MARKS: Record<string, "passed" | "failed" | "skipped"> = { "✓": "passed", "✕": "failed", "○": "skipped", "✎": "skipped" };

function jest(lines: string[]): TestFile[] {
  const files = new Files();
  let file: TestFile | null = null;
  let failure: Telling | null = null;
  const close = () => {
    if (failure && file) file.failures.push({ name: failure.name, ...told(failure.body), frames: failure.frames });
    failure = null;
  };
  for (const line of lines) {
    // Past 20 suites jest prints every failure a second time under this heading.
    if (line.startsWith("Summary of all failing tests") || /^Test Suites: /.test(line)) break;
    const named = JEST_FILE.exec(line);
    const mark = /^ +([✓✕○✎]) /.exec(line);
    const bullet = /^ +● (.+)$/.exec(line);
    if (named) {
      close();
      file = files.at(named[2]!.replace(/^\.\//, ""));
      file.state = named[1] === "FAIL" ? "failed" : "passed";
      file.ms = named[3] ? Math.round(Number(named[3]) * (named[4] === "ms" ? 1 : 1000)) : null;
    } else if (mark && file && !failure) file[JEST_MARKS[mark[1]!]!] += 1;
    else if (bullet && file) {
      close();
      failure = { name: lastPart(bullet[1]!, " › "), body: [], frames: [] };
    } else if (failure) tell(failure, line, JEST_FRAME.exec(line), JEST_CODE);
  }
  close();
  return files.all();
}

/* ------------------------------------------------------------------ pytest */

const PYTEST_MARKS: Record<string, "passed" | "failed" | "skipped"> = { ".": "passed", X: "passed", F: "failed", E: "failed", s: "skipped", x: "skipped" };
const PYTEST_WORDS: Record<string, "passed" | "failed" | "skipped"> = { PASSED: "passed", XPASS: "passed", FAILED: "failed", ERROR: "failed", SKIPPED: "skipped", XFAIL: "skipped" };

function pytest(lines: string[]): TestFile[] {
  const files = new Files();
  let section: { name: string; body: string[] } | null = null;
  const reported = new Set<string>();
  for (const line of lines) {
    const dots = /^(\S+\.py) ([.FEsxX]+)(?: +\[ *\d+%\])?$/.exec(line);
    const wordy = /^(\S+?\.py)::(\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/.exec(line);
    const head = /^_{3,} (.+?) _{3,}$/.exec(line);
    const where = /^(\S+\.py):(\d+): \w+/.exec(line);
    const summed = /^(?:FAILED|ERROR) (\S+?\.py)::(\S+?)(?: - (.+))?$/.exec(line);
    if (dots) for (const mark of dots[2]!) files.at(dots[1]!)[PYTEST_MARKS[mark]!] += 1;
    else if (wordy) files.at(wordy[1]!)[PYTEST_WORDS[wordy[3]!]!] += 1;
    else if (head) section = { name: lastPart(head[1]!, "."), body: [] };
    else if (section && where) {
      // The line that names the file ends a failure's section: its `E` lines say what went wrong.
      const said = section.body.flatMap((each) => (/^E( |$)/.test(each) ? [each.replace(/^E {0,7}/, "")] : []));
      files.at(where[1]!).failures.push({ name: section.name, ...told(said), frames: [frame(where[1]!, where[2]!)] });
      reported.add(section.name);
      section = null;
    } else if (section) section.body.push(line);
    // A run cut to its summary still names each failure there.
    else if (summed && !reported.has(lastPart(summed[2]!, "::"))) files.at(summed[1]!).failures.push({ name: lastPart(summed[2]!, "::"), message: summed[3] ?? "", detail: [], frames: [] });
  }
  return files.all();
}

/* ------------------------------------------------------------------ */

const readers: { detect: RegExp; read: (lines: string[]) => TestFile[] }[] = [
  { detect: /^ RUN +v\d|^ +Test Files +\d|^ [✓❯×↓] \S+ (?:> |\(\d+ tests?)|^ FAIL {1,2}\S/m, read: vitest },
  { detect: /^ ?(?:PASS|FAIL) {1,2}\S|^Test Suites: /m, read: jest },
  { detect: /^=+ test session starts =+$|^=+ .*\b(?:passed|failed|error)\b.* in [\d.]+s|^\S+\.py::\S+ (?:PASSED|FAILED)/m, read: pytest },
];

/** The files a run's output names, those with failures first; none when the output names no file or is no runner's the app reads this way. */
export function testReport(output: string): TestFile[] {
  const reader = readers.find(({ detect }) => detect.test(output));
  const files = reader ? reader.read(plain(output)) : [];
  return [...files.filter((file) => file.state === "failed"), ...files.filter((file) => file.state !== "failed")];
}
