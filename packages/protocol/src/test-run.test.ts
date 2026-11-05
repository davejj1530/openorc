import { describe, expect, it } from "vitest";
import { testRun, type TestRun } from "./test-run.js";

/** Real runner output from __fixtures__/test-runs; the computed path keeps the import out of the type checker's module lookup. */
const fixture = async (name: string): Promise<string> => (await import(`./__fixtures__/test-runs/${name}.txt?raw`)).default;
/** The output as it stood when it had printed everything before `marker`. */
const before = (text: string, marker: string) => text.slice(0, text.indexOf(marker));
const withoutDuration = (run: TestRun | null) => run && { ...run, durationMs: null };

const P = "passed";
const F = "failed";
const S = "skipped";

const mailerFailures = (file: string) => [
  { name: "sends once", file, message: 'expected "send" to be called 1 times, but got 2 times' },
  { name: "loads the template", file, message: "template missing: welcome.html" },
];

describe("vitest", () => {
  it("reads the default reporter's summary and failure blocks", async () => {
    expect(testRun(await fixture("vitest-fail"))).toEqual({
      runner: "vitest",
      passed: 7,
      failed: 2,
      skipped: 1,
      finished: true,
      durationMs: 896,
      failures: mailerFailures("src/mailer.test.ts"),
      cases: [],
    });
    expect(testRun(await fixture("vitest-pass"))).toEqual({ runner: "vitest", passed: 5, failed: 0, skipped: 1, finished: true, durationMs: 889, failures: [], cases: [] });
  });

  it("lists each case in printed order with the verbose reporter", async () => {
    expect(testRun(await fixture("vitest-verbose-fail"))).toEqual({
      runner: "vitest",
      passed: 7,
      failed: 2,
      skipped: 1,
      finished: true,
      durationMs: 892,
      failures: mailerFailures("src/mailer.test.ts"),
      cases: [P, P, P, S, F, P, P, F, P, P],
    });
  });

  it("reads the quiet output vitest prints inside an agent", async () => {
    expect(testRun(await fixture("vitest-agent-fail"))).toMatchObject({ passed: 7, failed: 2, skipped: 1, finished: true, failures: mailerFailures("src/mailer.test.ts"), cases: [] });
    expect(testRun(await fixture("vitest-agent-pass"))).toMatchObject({ passed: 5, failed: 0, skipped: 1, finished: true, durationMs: 897 });
  });

  it("reads coloured and terminal-redrawn output the same as plain output", async () => {
    const plain = withoutDuration(testRun(await fixture("vitest-fail")));
    expect(withoutDuration(testRun(await fixture("vitest-fail-color")))).toEqual(plain);
    expect(withoutDuration(testRun(await fixture("vitest-tty")))).toEqual(plain);
    const verbose = withoutDuration(testRun(await fixture("vitest-verbose-fail")));
    expect(withoutDuration(testRun(await fixture("vitest-verbose-fail-color")))).toEqual(verbose);
    expect(withoutDuration(testRun(await fixture("vitest-verbose-tty")))).toEqual(verbose);
  });

  it("counts a file that fails to load as a failure", async () => {
    expect(testRun(await fixture("vitest-broken-suite"))).toMatchObject({
      passed: 1,
      failed: 1,
      finished: true,
      failures: [{ name: "src/broken.test.ts", file: "src/broken.test.ts", message: expect.stringMatching(/^Cannot find module '\.\/missing-module' imported from /) }],
    });
  });

  it("counts per-file lines and lists failed cases before the summary prints", async () => {
    expect(testRun(before(await fixture("vitest-fail"), " ✓ src/queue.test.ts"))).toEqual({
      runner: "vitest",
      passed: 5,
      failed: 2,
      skipped: 1,
      finished: false,
      durationMs: null,
      failures: [
        { name: "sends once", file: "src/mailer.test.ts", message: "" },
        { name: "loads the template", file: "src/mailer.test.ts", message: "" },
      ],
      cases: [],
    });
  });

  it("counts verbose cases and their messages before the summary prints", async () => {
    expect(testRun(before(await fixture("vitest-verbose-fail"), " ✓ src/queue.test.ts > drains in order"))).toEqual({
      runner: "vitest",
      passed: 5,
      failed: 2,
      skipped: 1,
      finished: false,
      durationMs: null,
      failures: mailerFailures("src/mailer.test.ts"),
      cases: [P, P, P, S, F, P, P, F],
    });
  });

  it("reads the live summary a terminal shows mid-run", async () => {
    const tty = await fixture("vitest-tty");
    expect(testRun(tty.slice(0, tty.indexOf("404ms") + "404ms\r\n".length))).toMatchObject({ passed: 6, failed: 2, skipped: 1, finished: false, durationMs: 404 });
  });
});

describe("jest", () => {
  it("reads the summary and failure blocks", async () => {
    expect(testRun(await fixture("jest-fail"))).toEqual({
      runner: "jest",
      passed: 7,
      failed: 2,
      skipped: 1,
      finished: true,
      durationMs: 945,
      failures: [
        { name: "sends once", file: "mailer.test.js", message: "Expected number of calls: 1, Received number of calls: 2" },
        { name: "loads the template", file: "mailer.test.js", message: "template missing: welcome.html" },
      ],
      cases: [],
    });
    expect(testRun(await fixture("jest-pass"))).toEqual({ runner: "jest", passed: 5, failed: 0, skipped: 1, finished: true, durationMs: 912, failures: [], cases: [] });
  });

  it("lists each case in printed order with --verbose", async () => {
    expect(testRun(await fixture("jest-verbose-fail"))).toMatchObject({ passed: 7, failed: 2, skipped: 1, durationMs: 928, cases: [P, F, F, P, P, P, P, P, P, S] });
  });

  it("reads coloured, terminal-redrawn and agent output the same as plain output", async () => {
    const plain = withoutDuration(testRun(await fixture("jest-fail")));
    expect(withoutDuration(testRun(await fixture("jest-fail-color")))).toEqual(plain);
    expect(withoutDuration(testRun(await fixture("jest-tty")))).toEqual(plain);
    expect(withoutDuration(testRun(await fixture("jest-agent-fail")))).toEqual(plain);
    expect(withoutDuration(testRun(await fixture("jest-verbose-fail-color")))).toEqual(withoutDuration(testRun(await fixture("jest-verbose-fail"))));
  });

  it("counts a suite that fails to load as a failure", async () => {
    expect(testRun(await fixture("jest-broken-suite"))).toMatchObject({
      passed: 3,
      failed: 1,
      skipped: 1,
      failures: [{ name: "broken.test.js", file: "broken.test.js", message: "Cannot find module './missing-module' from 'broken.test.js'" }],
    });
  });

  it("lists a failure once when jest repeats it in its summary of failing tests", async () => {
    expect(testRun(await fixture("jest-many-suites"))).toMatchObject({ passed: 21, failed: 1, failures: [{ name: "breaks", file: "s22.test.js", message: "Expected: 2, Received: 1" }] });
  });

  it("counts what has printed before the summary", async () => {
    const partialVerbose = testRun(before(await fixture("jest-verbose-fail"), "PASS ./queue.test.js"));
    expect(partialVerbose).toMatchObject({ passed: 2, failed: 2, skipped: 0, finished: false, durationMs: null, cases: [P, F, F, P] });
    expect(partialVerbose?.failures.map(({ name }) => name)).toEqual(["sends once", "loads the template"]);
    expect(testRun(before(await fixture("jest-fail"), "PASS ./queue.test.js"))).toMatchObject({ passed: 0, failed: 2, skipped: 0, finished: false, cases: [] });
  });

  it("reads the live status a terminal shows mid-run as unfinished", async () => {
    const run = testRun(await fixture("jest-tty-mid-run"));
    expect(run).toMatchObject({ passed: 5, failed: 2, skipped: 1, finished: false });
    expect(run?.failures.map(({ name }) => name)).toEqual(["sends once", "loads the template"]);
  });
});

describe("go", () => {
  const mailer = [
    { name: "TestSendsOnce", file: "mailer_test.go", message: "send called 2 times, want 1" },
    { name: "backs_off", file: "mailer_test.go", message: "backoff was 100ms, want 200ms" },
  ];

  it("lists leaf tests with -v, not the parents of subtests", async () => {
    expect(testRun(await fixture("go-verbose-fail"))).toEqual({
      runner: "go",
      passed: 4,
      failed: 2,
      skipped: 1,
      finished: true,
      durationMs: 352,
      failures: mailer,
      cases: [P, P, S, F, P, P, F],
    });
    expect(testRun(await fixture("go-verbose-pass"))).toMatchObject({ passed: 2, failed: 0, skipped: 1, finished: true, durationMs: 196 });
  });

  it("reads failures without -v, where go prints no passing tests", async () => {
    expect(testRun(await fixture("go-fail"))).toEqual({ runner: "go", passed: 0, failed: 2, skipped: 0, finished: true, durationMs: 402, failures: mailer, cases: [] });
  });

  it("counts a package that fails to build as a failure", async () => {
    expect(testRun(await fixture("go-build-failed"))).toMatchObject({ failed: 1, failures: [{ name: "example.com/shop/broken", file: "broken/broken_test.go", message: "undefined: total" }] });
  });

  it("counts what has printed while a package still runs", async () => {
    expect(testRun(before(await fixture("go-verbose-fail"), "=== RUN   TestFormatsSubject"))).toMatchObject({
      passed: 2,
      failed: 1,
      skipped: 1,
      finished: false,
      cases: [P, P, S, F],
      failures: [mailer[0]],
    });
  });
});

describe("pytest (documented format)", () => {
  const failures = [
    { name: "test_applies_discount", file: "tests/test_cart.py", message: "assert 90.0 == 91" },
    { name: "test_adds_tax", file: "tests/test_cart.py", message: "assert 107.0 == 108" },
  ];

  it("reads -v case lines and the short test summary", async () => {
    expect(testRun(await fixture("pytest-documented-verbose-fail"))).toEqual({ runner: "pytest", passed: 2, failed: 2, skipped: 1, finished: true, durationMs: 40, failures, cases: [P, F, S, P, F] });
  });

  it("reads progress dots as cases", async () => {
    expect(testRun(await fixture("pytest-documented-fail"))).toEqual({ runner: "pytest", passed: 5, failed: 2, skipped: 1, finished: true, durationMs: 60, failures, cases: [P, F, S, P, F, P, P, P] });
  });

  it("counts what has printed before the summary", async () => {
    expect(testRun(before(await fixture("pytest-documented-verbose-fail"), "tests/test_cart.py::TestTotals::test_rounds_down"))).toMatchObject({
      passed: 1,
      failed: 1,
      skipped: 1,
      finished: false,
      failures: [{ name: "test_applies_discount", file: "tests/test_cart.py", message: "" }],
    });
  });
});

describe("cargo (documented format)", () => {
  it("reads case lines, the result line and the panic message", async () => {
    expect(testRun(await fixture("cargo-documented-fail"))).toEqual({
      runner: "cargo",
      passed: 2,
      failed: 1,
      skipped: 1,
      finished: true,
      durationMs: 10,
      failures: [{ name: "applies_discount", file: "src/cart.rs", message: "assertion `left == right` failed, left: 90, right: 91" }],
      cases: [P, S, F, P],
    });
  });

  it("adds up every test binary's result", async () => {
    expect(testRun(await fixture("cargo-documented-pass"))).toMatchObject({ passed: 3, failed: 0, skipped: 1, finished: true, durationMs: 210, cases: [P, S, P, P] });
  });

  it("is not finished while a later binary still runs", async () => {
    expect(testRun(before(await fixture("cargo-documented-pass"), "test result: ok. 1 passed"))).toMatchObject({ passed: 3, skipped: 1, finished: false });
  });
});

it("caps cases at 400, failures at 3 and messages at 300 characters, counting everything", () => {
  const passing = Array.from({ length: 450 }, (_, index) => `=== RUN   TestCase${index}\n--- PASS: TestCase${index} (0.00s)`);
  const failing = Array.from({ length: 4 }, (_, index) => `=== RUN   TestBroken${index}\n    broken_test.go:${index + 1}: ${"x".repeat(400)}\n--- FAIL: TestBroken${index} (0.00s)`);
  const run = testRun([...passing, ...failing, "FAIL", "FAIL\texample.com/shop\t0.120s", "FAIL"].join("\n"));
  expect(run).toMatchObject({ passed: 450, failed: 4, finished: true });
  expect(run?.cases).toEqual(Array<string>(400).fill(P));
  expect(run?.failures.map(({ name }) => name)).toEqual(["TestBroken0", "TestBroken1", "TestBroken2"]);
  expect(run?.failures[0]?.message).toHaveLength(300);
  expect(run?.failures[0]?.message.endsWith("…")).toBe(true);
});

it("returns null for output that is not a test run", () => {
  const outputs = [
    "",
    " M packages/protocol/src/index.ts\n?? packages/protocol/src/test-run.ts",
    "src/test-run.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1,3 +1,3 @@\n-const total = 1;\n+const total = 2;",
    "package.json\nsrc/test-run.ts\nsrc/test-run.test.ts",
    "All tests passed!",
  ];
  for (const output of outputs) expect(testRun(output)).toBeNull();
});
