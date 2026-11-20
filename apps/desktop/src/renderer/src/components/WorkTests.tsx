import { useMemo, useState } from "react";
import type { CaseResult } from "@openorc/protocol";
import { joinPath, testReport, toolInputView, toolResult, type Block, type TestCaseFailure, type TestFile, type TestFrame, type TestsObject } from "@openorc/client";
import { useToolOutput } from "../lib/tool-output";
import { Check, Minus, X } from "./icons";
import { Segmented } from "./Segmented";
import { ThreadLink } from "./ThreadImages";
import { StateMark } from "./WorkMarks";

type Cell = CaseResult | "pending";

/** Past this many cases a cell is too thin to see; the run draws as one track of shares instead. */
const MAX_CELLS = 48;

/**
 * One cell per case, in the order the runner printed them when it lists cases, otherwise passes, failures, skips.
 * A live run with a known total shows the cases still to come as empty cells.
 */
function cells(tests: TestsObject): Cell[] {
  const run = tests.run;
  // The cases a runner listed draw in order only when it listed them all; agent shells often print failures alone.
  const listed = run && run.cases.length === run.passed + run.failed + run.skipped;
  const counted = run ? [...repeat<Cell>("passed", run.passed), ...repeat<Cell>("failed", run.failed), ...repeat<Cell>("skipped", run.skipped)] : [];
  const printed: Cell[] = listed ? [...run.cases] : counted;
  const total = Math.max(printed.length, tests.state === "running" ? (tests.expected ?? 0) : 0);
  return [...printed, ...repeat<Cell>("pending", total - printed.length)];
}

const repeat = <T,>(value: T, count: number): T[] => Array.from({ length: Math.max(0, count) }, () => value);

function Count({ tests }: { tests: TestsObject }) {
  const run = tests.run;
  // A runner that names only its packages, like `go test` without -v, has no counts to show.
  if (!run || run.passed + run.failed + run.skipped === 0) return <span className="work-tests-count">{tests.chip.label}</span>;
  const key = `${run.passed}:${run.failed}`;
  return (
    <span className="work-tests-count motion-swap">
      <span key={key} className="motion-arrive">
        {run.failed ? (
          <>
            <span data-tone="bad">{run.failed} failed</span>
            <span className="work-ink-3"> · {run.passed} passed</span>
          </>
        ) : (
          <>
            {run.passed}
            {tests.state === "running" && tests.expected ? <span className="work-ink-3"> of {tests.expected}</span> : null} passed
          </>
        )}
        {run.skipped ? <span className="work-ink-3"> · {run.skipped} skipped</span> : null}
      </span>
    </span>
  );
}

function Track({ list }: { list: Cell[] }) {
  const share = (state: Cell) => (list.filter((cell) => cell === state).length / list.length) * 100;
  return (
    <span className="work-tests-track">
      {(["passed", "failed", "skipped", "pending"] as const).map((state) => (share(state) ? <span key={state} data-state={state} style={{ inlineSize: `${share(state)}%` }} /> : null))}
    </span>
  );
}

function duration(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** Files a run lists before the rest wait behind a count. */
const FILES = 8;

type ToolBlock = Extract<Block, { kind: "tool" }>;

/**
 * What a run's own output says file by file, and the folder its paths start from. The output is read whole, fetched
 * when the page left it out; a run that printed no file reads as none.
 */
export function useTestFiles(tests: TestsObject): { files: TestFile[]; cwd: string | null } {
  const call = tests.blocks.findLast((block): block is ToolBlock => block.kind === "tool");
  const output = useToolOutput(call ?? NO_CALL, Boolean(call));
  return useMemo(() => {
    const input = call ? toolInputView(call) : null;
    const text = output === undefined || output === null ? "" : toolResult(output).text;
    return { files: testReport(text), cwd: input?.kind === "command" ? input.cwd : null };
  }, [call, output]);
}

const NO_CALL: ToolBlock = { id: "", kind: "tool", name: "", input: null, done: true };

/**
 * A test run: its mark, the count, a cell per case and how long it took. Under it, the files it ran with the cases
 * that failed, each with what went wrong and where; or, when its output named no file, its first failures by name.
 */
export function TestsRun({ tests, files, cwd }: { tests: TestsObject; files: TestFile[]; cwd: string | null }) {
  const list = cells(tests);
  const run = tests.run;
  const label = run ? `${run.passed} passed, ${run.failed} failed${tests.expected && tests.state === "running" ? ` of ${tests.expected}` : ""}` : "No results yet";
  const took = duration(run?.durationMs ?? null);
  return (
    <div className="work-tests" data-state={tests.state}>
      <div className="work-tests-head">
        <StateMark state={run?.failed ? "failed" : tests.state} size={14} />
        <Count tests={tests} />
        {list.length ? (
          <span className="work-tests-cells" role="img" aria-label={label}>
            {list.length > MAX_CELLS ? <Track list={list} /> : list.map((state, index) => <span key={index} data-state={state} />)}
          </span>
        ) : null}
        {took ? <span className="work-chip-note work-align-end">{took}</span> : null}
        {tests.state === "stopped" ? <span className="work-chip-note">Stopped</span> : null}
      </div>
      {files.length ? <TestFiles files={files} cwd={cwd} /> : <NamedFailures tests={tests} />}
    </div>
  );
}

/** The first failures the run named, for output that listed no file. */
function NamedFailures({ tests }: { tests: TestsObject }) {
  const failures = tests.run?.failures ?? [];
  if (!failures.length) return null;
  return (
    <div className="work-failures">
      {failures.slice(0, 2).map((failure, index) => (
        <div key={index} className="work-failure">
          <span className="work-failure-name">{failure.name}</span>
          {failure.message ? <span className="work-failure-message">{failure.message}</span> : null}
        </div>
      ))}
    </div>
  );
}

type Shown = "all" | CaseResult;
const SHOWN: Record<CaseResult, string> = { failed: "Failed", passed: "Passed", skipped: "Skipped" };

/** The run's files, failed ones first. Where they came out differently, a filter narrows them to one outcome. */
function TestFiles({ files, cwd }: { files: TestFile[]; cwd: string | null }) {
  const [shown, setShown] = useState<Shown>("all");
  const [every, setEvery] = useState(false);
  const outcomes = (["failed", "passed", "skipped"] as const).filter((state) => files.some((file) => file.state === state));
  const matching = shown === "all" ? files : files.filter((file) => file.state === shown);
  const listed = every ? matching : matching.slice(0, FILES);
  return (
    <div className="work-test-files">
      {outcomes.length > 1 ? (
        <Segmented size="sm" label="Files shown" value={shown} options={[{ value: "all", label: "All" }, ...outcomes.map((state) => ({ value: state, label: SHOWN[state] }))]} onChange={setShown} />
      ) : null}
      <ul>
        {listed.map((file) => (
          <FileRow key={file.path} file={file} cwd={cwd} />
        ))}
      </ul>
      {matching.length > listed.length ? (
        <button type="button" className="work-more" onClick={() => setEvery(true)}>
          {matching.length - listed.length} more files
        </button>
      ) : null}
    </div>
  );
}

const MARKS = { passed: Check, failed: X, skipped: Minus };
const plural = (count: number, word: string) => (count ? `${count} ${word}` : "");

/** One file: how it came out, its name as the way to it, its counts and time, and under it each case that failed. */
function FileRow({ file, cwd }: { file: TestFile; cwd: string | null }) {
  const Mark = MARKS[file.state];
  const name = file.path.split(/[\\/]/).at(-1) ?? file.path;
  const counts = [plural(file.failed, "failed"), plural(file.passed, "passed"), plural(file.skipped, "skipped")].filter(Boolean).join(" · ");
  return (
    <li className="work-test-file" data-state={file.state}>
      <div className="work-test-file-head">
        <Mark size={13} className="work-test-mark" />
        <span className="work-test-file-name" data-tip={file.path}>
          <ThreadLink href={joinPath(cwd, file.path)}>{name}</ThreadLink>
        </span>
        <span className="work-chip-detail">{file.path.slice(0, -name.length).replace(/\/$/, "")}</span>
        <span className="work-chip-note">{counts}</span>
        {file.ms === null ? null : <span className="work-chip-note">{duration(file.ms)}</span>}
      </div>
      {file.failures.map((failure, index) => (
        <FailedCase key={`${index}:${failure.name}`} failure={failure} cwd={cwd} />
      ))}
    </li>
  );
}

/** A case that failed: its name, what went wrong, what was expected and got, then where in the project's own code. */
function FailedCase({ failure, cwd }: { failure: TestCaseFailure; cwd: string | null }) {
  return (
    <div className="work-failure">
      <span className="work-failure-name">{failure.name}</span>
      {failure.message ? <span className="work-failure-message">{failure.message}</span> : null}
      {failure.detail.length ? <pre className="work-test-detail">{failure.detail.join("\n")}</pre> : null}
      <Frames frames={failure.frames} cwd={cwd} />
    </div>
  );
}

/** Where it failed: each line of the project's own code opens there. Code the project did not write waits behind a count. */
function Frames({ frames, cwd }: { frames: TestFrame[]; cwd: string | null }) {
  const [library, setLibrary] = useState(false);
  const own = frames.filter((frame) => !frame.library);
  const others = frames.filter((frame) => frame.library);
  if (!frames.length) return null;
  return (
    <div className="work-test-frames">
      {own.map((frame, index) => (
        <ThreadLink key={index} href={`${joinPath(cwd, frame.path)}#L${frame.line}`}>{`${frame.path}:${frame.line}`}</ThreadLink>
      ))}
      {library ? others.map((frame, index) => <span key={index}>{`${frame.path}:${frame.line}`}</span>) : null}
      {others.length && !library ? (
        <button type="button" className="work-more" onClick={() => setLibrary(true)}>
          {others.length} library {others.length === 1 ? "frame" : "frames"}
        </button>
      ) : null}
    </div>
  );
}
