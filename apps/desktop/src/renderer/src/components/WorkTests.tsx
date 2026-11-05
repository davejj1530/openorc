import type { CaseResult } from "@openorc/protocol";
import type { TestsObject } from "@openorc/client";
import { CallRow, StateMark, type RenderBlocks } from "./WorkMarks";

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

/** A test run: its mark, the count, a cell per case, what it ran and how long it took; a failure, named, under it. */
export function TestsRun({ tests, renderBlocks }: { tests: TestsObject; renderBlocks: RenderBlocks }) {
  const list = cells(tests);
  const run = tests.run;
  const label = run ? `${run.passed} passed, ${run.failed} failed${tests.expected && tests.state === "running" ? ` of ${tests.expected}` : ""}` : "No results yet";
  const took = duration(run?.durationMs ?? null);
  const failures = run?.failures.length ? (
    <div className="work-failures">
      {run.failures.slice(0, 2).map((failure, index) => (
        <div key={index} className="work-failure">
          <span className="work-failure-name">{failure.name}</span>
          {failure.message ? <span className="work-failure-message">{failure.message}</span> : null}
        </div>
      ))}
    </div>
  ) : null;
  return (
    <div className="work-tests" data-state={tests.state}>
      <CallRow chip={{ ...tests.chip, kind: "intent" }} calls={tests.blocks} renderBlocks={renderBlocks} under={failures}>
        <StateMark state={run?.failed ? "failed" : tests.state} size={14} />
        <Count tests={tests} />
        {list.length ? (
          <span className="work-tests-cells" role="img" aria-label={label}>
            {list.length > MAX_CELLS ? <Track list={list} /> : list.map((state, index) => <span key={index} data-state={state} />)}
          </span>
        ) : null}
        <span className="work-chip-detail work-align-end">{tests.chip.detail}</span>
        {took ? <span className="work-chip-note">{took}</span> : null}
        {tests.state === "stopped" ? <span className="work-chip-note">Stopped</span> : null}
      </CallRow>
    </div>
  );
}
