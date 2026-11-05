/**
 * Reads a test runner's printed output into counts, failures and cases: vitest, jest, pytest, cargo and go.
 * Works on complete output and on output cut while the run is still going.
 */

export type TestRunner = "vitest" | "jest" | "pytest" | "cargo" | "go";
export type CaseResult = "passed" | "failed" | "skipped";

export interface TestFailure {
  name: string;
  file: string | null;
  message: string;
}

export interface TestRun {
  runner: TestRunner;
  passed: number;
  failed: number;
  skipped: number;
  /** The runner printed its final summary. False while it runs, or when the output was cut before it. */
  finished: boolean;
  /** The first three failures in printed order; message is the first meaningful line (e.g. "expected "send" to be called 1 time, but got 2 times"), at most 300 chars. */
  failures: TestFailure[];
  durationMs: number | null;
  /** Each case in printed order when the runner lists cases (vitest/jest verbose, pytest -v, cargo, go -v), capped at 400; empty when it lists only files. */
  cases: CaseResult[];
}

type Counts = Pick<TestRun, "passed" | "failed" | "skipped">;
type Reading = Omit<TestRun, "runner" | keyof Counts> & { counts: Counts };

interface RunnerReader {
  runner: TestRunner;
  /** Lines only this runner prints at its start, per case, or at its end, so output cut anywhere still matches. */
  detect: RegExp;
  read: (lines: string[]) => Reading;
}

const MAX_CASES = 400;
const MAX_FAILURES = 3;
const MAX_MESSAGE = 300;

const marks: Record<CaseResult, string[]> = {
  passed: ["✓", "ok", "PASS", "PASSED", "passed", ".", "X", "XPASS", "xpassed"],
  failed: ["×", "✕", "FAIL", "FAILED", "failed", "F", "E", "ERROR", "error", "errors"],
  skipped: ["↓", "○", "✎", "SKIP", "SKIPPED", "skipped", "ignored", "todo", "s", "x", "XFAIL", "xfailed"],
};

/** What a runner's case mark or summary word says about a case. */
const results = new Map((Object.entries(marks) as [CaseResult, string[]][]).flatMap(([result, words]) => words.map((word) => [word, result] as const)));

/**
 * The output's lines without terminal codes, each redrawn line as `\r` last drew it. On a TTY vitest and jest also
 * leave stale live-progress frames above their output; readers take the last summary, which is the newest.
 */
function plainLines(text: string): string[] {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      .split("\n")
      .map((line) => line.replace(/\r+$/, "").split("\r").at(-1)!)
  );
}

function tally(cases: CaseResult[]): Counts {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const result of cases) counts[result]++;
  return counts;
}

/** Counts from a summary such as "2 failed | 7 passed | 1 skipped" or "11 passed; 1 failed; 0 ignored". */
function countsIn(summary: string): Counts {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const [, count, word] of summary.matchAll(/(\d+) (\w+)/g)) {
    const result = results.get(word!);
    if (result) counts[result] += Number(count);
  }
  return counts;
}

function lastMatch(lines: string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = pattern.exec(lines[index]!);
    if (match) return match;
  }
  return null;
}

function milliseconds(value: string, unit: string): number {
  return Math.round(Number(value) * (unit === "ms" ? 1 : 1000));
}

/** The case's own name: the last segment of its suite path. */
function ownName(title: string, separator: string): string {
  return title.split(separator).at(-1)!.trim();
}

/** The first meaningful line from `from` on, with the Expected/Received or left/right lines that follow it. */
function messageFrom(lines: string[], from: number): string {
  const [first = "", ...rest] = lines
    .slice(from, from + 12)
    .map((line) => line.trim())
    .filter((line) => line && !/^expect[(.]/.test(line));
  return [first, ...rest.slice(0, 2).filter((line) => /^(?:Expected|Received|left|right)\b[^:]*:/.test(line))].join(", ");
}

/** Counts from the final summary once printed; before it, from the cases listed so far, else from what the runner prints instead of cases. */
function countsSoFar(summary: RegExpExecArray | null, cases: CaseResult[], withoutCases: Counts): Counts {
  if (summary) return countsIn(summary[1]!);
  return cases.length ? tally(cases) : withoutCases;
}

/** A suite that fails to load runs no cases; it counts as one failure so the run never reads as passed. */
function withBrokenSuites(counts: Counts, brokenSuites: number): Counts {
  return { ...counts, failed: counts.failed + brokenSuites };
}

/** What pytest printed line by line: each case's mark, the failures it listed and reported, each failure's first `E` line. */
function pytestLines(lines: string[]) {
  const cases: CaseResult[] = [];
  const listed: { id: string; file: string }[] = [];
  const reported: TestFailure[] = [];
  const firstErrorLines = new Map<string, string>();
  let section: string | null = null;
  for (const line of lines) {
    let match: RegExpExecArray | null;
    if ((match = /^(\S+?)::(\S+) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/.exec(line))) {
      const result = results.get(match[3]!)!;
      cases.push(result);
      if (result === "failed") listed.push({ id: match[2]!, file: match[1]! });
    } else if ((match = /^(?:\S+\.py ([.FEsxX]+)(?: +\[ *\d+%\])?|([.FEsxX]+) +\[ *\d+%\])$/.exec(line))) {
      for (const mark of match[1] ?? match[2]!) cases.push(results.get(mark)!);
    } else if ((match = /^(?:FAILED|ERROR) ([^\s:]+)(?:::(\S+))?(?: - (.+))?$/.exec(line))) {
      reported.push({ name: ownName(match[2] ?? match[1]!, "::"), file: match[1]!, message: match[3] ?? "" });
    } else if ((match = /^_{3,} (.+?) _{3,}$/.exec(line))) section = match[1]!;
    else if ((match = /^E +(.+)$/.exec(line)) && section && !firstErrorLines.has(section)) firstErrorLines.set(section, match[1]!);
  }
  return { cases, listed, reported, firstErrorLines };
}

const readers: RunnerReader[] = [
  {
    runner: "vitest",
    detect: /^ RUN +v\d|^ +Test Files +\d|^ [✓❯×↓] \S+ (?:> |\(\d+ tests?)/m,
    read(lines) {
      const cases: CaseResult[] = [];
      const listed: TestFailure[] = [];
      const reported: TestFailure[] = [];
      const perFile = { passed: 0, failed: 0, skipped: 0 };
      let file: string | null = null;
      let brokenSuites = 0;
      for (const [index, line] of lines.entries()) {
        let match: RegExpExecArray | null;
        if ((match = /^ ([✓×↓]) (\S+) > (.+?)(?: \d+ms)?$/.exec(line))) {
          cases.push(results.get(match[1]!)!);
          const message = /^ +→ (.+)$/.exec(lines[index + 1] ?? "")?.[1] ?? "";
          if (match[1] === "×") listed.push({ name: ownName(match[3]!, " > "), file: match[2]!, message });
        } else if ((match = /^ [✓❯×↓] (\S+) \((\d+) tests?((?: \| \d+ \w+)*)\)/.exec(line))) {
          file = match[1]!;
          const { failed, skipped } = countsIn(match[3]!);
          perFile.passed += Number(match[2]) - failed - skipped;
          perFile.failed += failed;
          perFile.skipped += skipped;
        } else if ((match = /^ {3,}× (.+?)(?: +\d+ms)?$/.exec(line))) {
          listed.push({ name: match[1]!, file, message: "" });
        } else if ((match = /^ FAIL {2}(\S+)(?: > (.+)| \[ .+ \])$/.exec(line))) {
          if (!match[2]) brokenSuites++;
          reported.push({ name: ownName(match[2] ?? match[1]!, " > "), file: match[1]!, message: messageFrom(lines, index + 1).replace(/^(?:Assertion)?Error: /, "") });
        }
      }
      const summary = lastMatch(lines, /^ +Tests +(.+?) *\(\d+\)$/);
      // The live summary a TTY redraws has no breakdown after its duration; the final one does.
      const duration = lastMatch(lines, /^ +Duration +([\d.]+)(m?s)( \()?/);
      return {
        counts: withBrokenSuites(countsSoFar(summary, cases, perFile), brokenSuites),
        finished: Boolean(duration?.[3]),
        durationMs: duration ? milliseconds(duration[1]!, duration[2]!) : null,
        cases,
        failures: reported.length ? reported : listed,
      };
    },
  },
  {
    runner: "jest",
    detect: /^ ?(?:PASS|FAIL|RUNS) {1,2}\S|^Test Suites: /m,
    read(lines) {
      const cases: CaseResult[] = [];
      const failures: TestFailure[] = [];
      let file: string | null = null;
      let brokenSuites = 0;
      for (const [index, line] of lines.entries()) {
        // Past 20 suites jest prints every failure a second time under this heading.
        if (line.startsWith("Summary of all failing tests")) break;
        let match: RegExpExecArray | null;
        if ((match = /^ ?(?:PASS|FAIL) {1,2}(\S+)/.exec(line))) file = match[1]!.replace(/^\.\//, "");
        else if ((match = /^ +([✓✕○✎]) /.exec(line))) cases.push(results.get(match[1]!)!);
        else if ((match = /^ +● (.+)$/.exec(line))) {
          const broken = match[1] === "Test suite failed to run";
          if (broken) brokenSuites++;
          failures.push({ name: broken ? (file ?? match[1]!) : ownName(match[1]!, " › "), file, message: messageFrom(lines, index + 1) });
        }
      }
      const summary = lastMatch(lines, /^Tests: +(.+)$/);
      const suites = lastMatch(lines, /^Test Suites: +(.+)$/);
      const time = lastMatch(lines, /^Time: +([\d.]+) ?(m?s)/);
      return {
        counts: withBrokenSuites(countsSoFar(summary, cases, { passed: 0, failed: failures.length - brokenSuites, skipped: 0 }), brokenSuites),
        // While it runs, jest's live status counts suites as "2 of 3 total".
        finished: Boolean(suites && !/ of \d+ total/.test(suites[1]!)),
        durationMs: time ? milliseconds(time[1]!, time[2]!) : null,
        cases,
        failures,
      };
    },
  },
  {
    runner: "pytest",
    detect: /^=+ test session starts =+$|^\S+::\S+ (?:PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b|^=+ .+ in [\d.]+s\b.*=+$/m,
    read(lines) {
      const { cases, listed, reported, firstErrorLines } = pytestLines(lines);
      const summary = lastMatch(lines, /^=+ (.+?) in ([\d.]+)s\b.*=+$/);
      return {
        counts: summary ? countsIn(summary[1]!) : tally(cases),
        finished: Boolean(summary),
        durationMs: summary ? milliseconds(summary[2]!, "s") : null,
        cases,
        failures: reported.length ? reported : listed.map(({ id, file }) => ({ name: ownName(id, "::"), file, message: firstErrorLines.get(id.replaceAll("::", ".")) ?? "" })),
      };
    },
  },
  {
    runner: "cargo",
    detect: /^running \d+ tests?$|^test .+ \.\.\. (?:ok|FAILED|ignored)\b|^test result: /m,
    read(lines) {
      const cases: CaseResult[] = [];
      const listed: TestFailure[] = [];
      const reported: TestFailure[] = [];
      const binaries: string[] = [];
      let started = 0;
      let seconds = 0;
      for (const [index, line] of lines.entries()) {
        let match: RegExpExecArray | null;
        if (/^running \d+ tests?$/.test(line)) started++;
        else if ((match = /^test (.+?) \.\.\. (ok|FAILED|ignored)\b/.exec(line))) {
          cases.push(results.get(match[2]!)!);
          if (match[2] === "FAILED") listed.push({ name: ownName(match[1]!, "::"), file: null, message: "" });
        } else if ((match = /^thread '(.+?)' panicked at (.+?):\d+:\d+:$/.exec(line))) {
          reported.push({ name: ownName(match[1]!, "::"), file: match[2]!, message: messageFrom(lines, index + 1) });
        } else if ((match = /^test result: \w+\. (.+?); finished in ([\d.]+)s$/.exec(line))) {
          binaries.push(match[1]!);
          seconds += Number(match[2]);
        }
      }
      // cargo runs one binary per crate target, each with its own "running" line and result.
      const finished = binaries.length > 0 && binaries.length === started;
      return {
        counts: finished ? countsIn(binaries.join("; ")) : tally(cases),
        finished,
        durationMs: binaries.length ? Math.round(seconds * 1000) : null,
        cases,
        failures: reported.length ? reported : listed,
      };
    },
  },
  {
    runner: "go",
    detect: /^=== RUN |^ *--- (?:PASS|FAIL|SKIP): |^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[\w+ failed\])$/m,
    read(lines) {
      const ran: { name: string; result: CaseResult; at: number }[] = [];
      const brokenPackages: { name: string; at: number }[] = [];
      const firstLogs = new Map<string, { file: string; message: string }>();
      const packageSeconds: number[] = [];
      let current = "";
      let verbose = false;
      for (const [index, line] of lines.entries()) {
        let match: RegExpExecArray | null;
        if ((match = /^=== (?:RUN|CONT) +(\S+)/.exec(line))) {
          verbose = true;
          current = match[1]!;
        } else if ((match = /^ *--- (PASS|FAIL|SKIP): (\S+) \(/.exec(line))) {
          current = match[2]!;
          ran.push({ name: current, result: results.get(match[1]!)!, at: index });
        } else if ((match = /^# (\S+)/.exec(line))) current = match[1]!;
        else if ((match = /^ *(\S+\.go):\d+(?::\d+)?: (.+)$/.exec(line))) {
          if (!firstLogs.has(current)) firstLogs.set(current, { file: match[1]!, message: match[2]! });
        } else if ((match = /^FAIL\s+(\S+) \[\w+ failed\]$/.exec(line))) brokenPackages.push({ name: match[1]!, at: index });
        else if ((match = /^(?:ok|FAIL)\s+\S+\s+([\d.]+)s$/.exec(line))) packageSeconds.push(Number(match[1]));
      }
      // A test with subtests reports their results again as its own; count only the leaves.
      const parents = new Set(ran.filter(({ name }) => name.includes("/")).map(({ name }) => name.slice(0, name.lastIndexOf("/"))));
      const leaves = ran.filter(({ name }) => !parents.has(name));
      const failed = [
        ...leaves.filter(({ result }) => result === "failed").map(({ name, at }) => ({ name: ownName(name, "/"), key: name, at })),
        ...brokenPackages.map(({ name, at }) => ({ name, key: name, at })),
      ].sort((a, b) => a.at - b.at);
      const lastLine = lines.findLast((line) => line.trim()) ?? "";
      return {
        counts: withBrokenSuites(tally(leaves.map(({ result }) => result)), brokenPackages.length),
        // go prints no run summary; a run reads finished once its last line closes a package.
        finished: /^(?:ok|FAIL|\?)(?:\s|$)/.test(lastLine),
        // Packages run in parallel, so the slowest one is the run's length.
        durationMs: packageSeconds.length ? Math.round(Math.max(...packageSeconds) * 1000) : null,
        cases: verbose ? leaves.map(({ result }) => result) : [],
        failures: failed.map(({ name, key }) => ({ name, file: firstLogs.get(key)?.file ?? null, message: firstLogs.get(key)?.message ?? "" })),
      };
    },
  },
];

const clip = (text: string) => (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text);

/** A test run read from a runner's output, complete or still streaming. Null when the text is not test-runner output. */
export function testRun(text: string): TestRun | null {
  const lines = plainLines(text);
  const shown = lines.join("\n");
  const reader = readers.find(({ detect }) => detect.test(shown));
  if (!reader) return null;
  const { counts, failures, cases, ...rest } = reader.read(lines);
  return {
    runner: reader.runner,
    ...counts,
    ...rest,
    failures: failures.slice(0, MAX_FAILURES).map((failure) => ({ ...failure, message: clip(failure.message) })),
    cases: cases.slice(0, MAX_CASES),
  };
}
