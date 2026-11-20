import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import calls from "./test-fixtures/work-calls.json";
import { testReport } from "./test-report.js";

/** What a recorded call printed. */
function printed(label: string): string {
  const done = calls.find((call) => call.label.startsWith(label))?.events.find((event) => event.type === "tool.completed") as { output?: unknown } | undefined;
  return typeof done?.output === "string" ? done.output : JSON.stringify(done?.output);
}

/** Runner output recorded for the digest's own tests. */
const recorded = (name: string) => readFileSync(new URL(`../../protocol/src/__fixtures__/test-runs/${name}.txt`, import.meta.url), "utf8");

describe("vitest", () => {
  it("reads each failing file with its failures: what went wrong, what was expected, and where", () => {
    const files = testReport(printed("vitest run failing, unpiped"));
    expect(files.map((file) => [file.path, file.state, file.passed, file.failed, file.skipped])).toEqual([
      ["src/greeting.test.ts", "failed", 1, 1, 2],
      ["src/session.test.ts", "failed", 2, 1, 0],
    ]);
    // The code the runner prints under the frame is the frame's link to open, not part of the telling.
    expect(files[0]!.failures).toEqual([
      {
        name: "trims the name",
        message: "AssertionError: expected 'Hello,  Ada !' to be 'Hello, Ada!' // Object.is equality",
        detail: ['Expected: "Hello, Ada!"', 'Received: "Hello,  Ada !"'],
        frames: [{ path: "src/greeting.test.ts", line: 5, library: false }],
      },
    ]);
    expect(files[1]!.failures[0]!.detail).toEqual(["- Expected", "+ Received", "- 86400", "+ 1209600"]);
  });

  it("counts cases listed one a line, and reads a file that could not load as one failure", () => {
    expect(testReport(recorded("vitest-verbose-fail")).map((file) => [file.path, file.state, file.passed > 0])).toContainEqual(["src/mailer.test.ts", "failed", true]);
    const broken = testReport(recorded("vitest-broken-suite")).find((file) => file.path === "src/broken.test.ts");
    expect(broken).toMatchObject({ state: "failed", failures: [{ name: "The file did not load" }] });
    expect(broken!.failures[0]!.message).toBeTruthy();
  });

  it("counts a listed file's cases and time, and reads a project's files past the project's name", () => {
    const output = [
      " RUN  v4.1.11 /repo",
      " ✓ |renderer| src/a.test.tsx (12 tests) 18ms",
      " ❯ |renderer| src/b.test.tsx (4 tests | 1 failed | 1 skipped) 60ms",
      " FAIL  |renderer| src/b.test.tsx > proof > opens the work",
      "AssertionError: expected 423, got 401",
      "",
      "- Expected",
      "+ Received",
      "",
      " ❯ src/b.test.tsx:58:31",
      "     57|   it('opens', () => {",
      " ❯ node_modules/vitest/dist/chunk.js:12:3",
      "⎯⎯⎯⎯[1/1]⎯",
      " Test Files  1 failed | 1 passed (2)",
    ].join("\n");
    expect(testReport(output)).toEqual([
      {
        path: "src/b.test.tsx",
        state: "failed",
        passed: 2,
        failed: 1,
        skipped: 1,
        ms: 60,
        failures: [
          {
            name: "opens the work",
            message: "AssertionError: expected 423, got 401",
            detail: ["- Expected", "+ Received"],
            frames: [
              { path: "src/b.test.tsx", line: 58, library: false },
              { path: "node_modules/vitest/dist/chunk.js", line: 12, library: true },
            ],
          },
        ],
      },
      { path: "src/a.test.tsx", state: "passed", passed: 12, failed: 0, skipped: 0, ms: 18, failures: [] },
    ]);
  });

  it("names no file for a run cut down to its summary", () => {
    expect(testReport(" Test Files  2 passed (2)\n      Tests  23 passed (23)\n   Duration  370ms")).toEqual([]);
  });
});

it("reads jest's failures under their file, and its passing files after", () => {
  const files = testReport(recorded("jest-fail"));
  expect(files.map((file) => [file.path, file.state])).toEqual([
    ["mailer.test.js", "failed"],
    ["queue.test.js", "passed"],
    ["cart.test.js", "passed"],
  ]);
  expect(files[0]!.failures).toEqual([
    {
      name: "sends once",
      message: "expect(send).toHaveBeenCalledTimes(expected)",
      detail: ["    Expected number of calls: 1", "    Received number of calls: 2"],
      frames: [{ path: "mailer.test.js", line: 7, library: false }],
    },
    { name: "loads the template", message: "template missing: welcome.html", detail: [], frames: [{ path: "mailer.test.js", line: 13, library: false }] },
  ]);
});

it("reads pytest's failures from their sections, with the line each failed on", () => {
  const files = testReport(recorded("pytest-documented-fail"));
  const failed = files.filter((file) => file.state === "failed");
  expect(failed.length).toBeGreaterThan(0);
  const [failure] = failed[0]!.failures;
  expect(failure!.message).toBeTruthy();
  expect(failure!.frames[0]).toMatchObject({ path: failed[0]!.path, library: false });
});

it("reads nothing from output that is no test runner's", () => {
  expect(testReport("M src/a.ts\n?? src/b.ts")).toEqual([]);
});
